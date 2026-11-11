import { setTimeout } from "node:timers/promises";
import { and, eq, isNull, lt, ne, sql as sqlExpression } from "drizzle-orm";
import {
  defineSandboxProvider, SandboxSessionGoneError,
  type SandboxConnection, type SandboxPrepareContext, type SandboxSessionContext,
  type SandboxSessionEndOptions,
} from "eve/sandbox/provider";
import { loadConfig } from "@/lib/config";
import { getDb, getLockSqlClient } from "@/lib/db/client";
import { appSessions, daytonaKeys, sandboxes, type DaytonaKey, type SandboxLaunch } from "@/lib/db/schema";
import { bindAppSession, findAppSessionById } from "@/lib/sessions/service";
import { decryptSecret, DAYTONA_KEY_PURPOSE } from "@/lib/secrets";
import { errorStatus, isMissingSandbox, sandboxFailure, StudioSandboxError } from "@/lib/sandbox/errors";
import { abortable } from "@/lib/sandbox/abort";
import { sandboxState } from "@/lib/sandbox/daytona-state";
import type { SandboxState as StoredState } from "@/lib/db/schema";
export { sandboxState } from "@/lib/sandbox/daytona-state";
import { waitForSandboxMaintenance } from "@/lib/sandbox/maintenance";
import {
  assertSandboxWait, beginSandboxLaunch, captureSandboxWait, readSandboxCopyWait, type SandboxWait,
} from "@/lib/sandbox/wait-generation";
import { daytonaBackend, daytonaSandboxName, type DaytonaBackend, type DaytonaMachine } from "./daytona-backend";
import { awaitSlot } from "./sandbox-queue";
import {
  DELETED_KEY_MARKER,
  exhaustPool,
  forgetPendingDeletion,
  isQuotaExceeded,
  markKeyUnauthorized,
  rememberPendingDeletion,
} from "./daytona-key-pool";

const HOME_MARKER = "/__eve_home__";
type Artifact = { templateKey: string; dockerfile: string; files: { path: string; content: string }[] };
type State = { keyId: string; sandboxId: string };

/** Машина создана, но убрать её после сбоя не удалось: резерв нельзя терять. */
class KeepReservationError extends Error {
  constructor(readonly cause: unknown) {
    super("Песочница создана, но очистка после сбоя не удалась.");
    this.name = "KeepReservationError";
  }
}
async function boundSession(
  eveSessionId: string,
  auth?: SandboxSessionContext["session"]["auth"],
) {
  // Первое сообщение со вложениями: eve раскладывает файлы в песочницу до
  // того, как хук сохранения запишет привязку. Идентификатор сессии приложения
  // уже есть в аутентификаторе канала — берём строку по нему, но только если
  // она ещё свободна или принадлежит этой же сессии eve.
  const initiator = auth?.initiator ?? null;
  const claimed = initiator?.attributes.appSessionId;
  if (initiator !== null && typeof claimed === "string") {
    const session = await findAppSessionById(claimed);
    if (
      session !== null &&
      session.userId === initiator.principalId &&
      (session.eveSessionId === null || session.eveSessionId === eveSessionId)
    ) {
      if (session.eveSessionId === eveSessionId) return session;
      // Стрим открывается ещё до session.started. Подготовка вложения может
      // длиться дольше окна ожидания канала: закрепляем владельца до Daytona,
      // тем же атомарным способом, которым это делает хук сохранения.
      if (await bindAppSession(session.id, initiator.principalId, eveSessionId)) {
        return { ...session, eveSessionId };
      }
      const current = await findAppSessionById(session.id);
      if (current?.userId === initiator.principalId && current.eveSessionId === eveSessionId) {
        return current;
      }
    }
  }

  const deadline = Date.now() + 10_000;
  do {
    const [session] = await getDb().select().from(appSessions).where(eq(appSessions.eveSessionId, eveSessionId));
    if (session !== undefined) return session;
    await setTimeout(500);
  } while (Date.now() < deadline);
  throw new StudioSandboxError("session_not_bound");
}

async function backendFor(keyId: string) {
  const [key] = await getDb().select().from(daytonaKeys).where(eq(daytonaKeys.id, keyId));
  return backendForKey(key);
}

function backendForKey(key: Pick<DaytonaKey, "id" | "apiKeyEncrypted" | "deletedAt"> | undefined, allowDeleted = false) {
  if (key === undefined || key.apiKeyEncrypted === DELETED_KEY_MARKER) {
    throw new SandboxSessionGoneError("Ключ песочницы удалён.");
  }
  if (!allowDeleted && key.deletedAt !== null) throw new SandboxSessionGoneError("Ключ песочницы удалён.");
  return daytonaBackend(key.id, decryptSecret(key.apiKeyEncrypted, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE));
}

async function liveMachine(
  backend: DaytonaBackend,
  id: string,
  onLaunch?: (kind: SandboxLaunch) => Promise<DaytonaMachine | void>,
  guard?: () => Promise<void>,
): Promise<DaytonaMachine> {
  let machine: DaytonaMachine;
  try { machine = await backend.get(id); }
  catch (error) {
    if (isMissingSandbox(error)) throw new SandboxSessionGoneError("Песочница утрачена.");
    throw error;
  }
  // Auto-stop/archive can still be transitioning when a new step arrives.
  // waitUntilStarted alone would never restart the eventual stopped machine.
  const deadline = Date.now() + 300_000;
  while (machine.state === "stopping" || machine.state === "archiving") {
    if (Date.now() >= deadline) throw new StudioSandboxError("sandbox_start_failed");
    await setTimeout(500);
    try { machine = await backend.get(id); }
    catch (error) {
      if (isMissingSandbox(error)) throw new SandboxSessionGoneError("Песочница утрачена.");
      throw error;
    }
  }
  await guard?.();
  if (sandboxStateForLoss(machine.state)) throw new SandboxSessionGoneError("Песочница утрачена.");
  if (machine.state === "error" || machine.state === "build_failed") {
    if (machine.state === "error" && machine.recoverable) {
      const opened = await onLaunch?.("restore");
      if (opened) return opened;
      await machine.recover();
    } else {
      await machine.delete();
      throw new SandboxSessionGoneError("Песочница утрачена.");
    }
  } else if (machine.state === "stopped" || machine.state === "archived") {
    // Строка `starting` резервирует место в квоте, пока Daytona не покажет
    // запущенную машину: её данные отстают от изменения.
    const opened = await onLaunch?.(machine.state === "archived" ? "restore" : "wake");
    if (opened) return opened;
    await machine.start();
  } else if (machine.state !== "started") {
    sandboxState(machine.state);
    await machine.ready();
  }
  return machine;
}

/** Резерв места в пуле до того, как Daytona обновит использование. */
async function reserveLaunch(appSessionId: string, keyId: string, kind: SandboxLaunch, wait: SandboxWait): Promise<void> {
  await getDb()
    .update(sandboxes)
    .set({ daytonaKeyId: keyId, state: "starting", startingSince: new Date(), startingKind: kind })
    .where(and(eq(sandboxes.appSessionId, appSessionId), eq(sandboxes.waitGeneration, wait.generation)));
}

/** Снимает резерв; сбой записи не должен подменять исходную ошибку старта. */
async function updateReservation(
  appSessionId: string,
  values: { state?: "gone"; startingSince: null; startingKind: null },
  wait: SandboxWait,
): Promise<void> {
  try {
    await getDb()
      .update(sandboxes)
      .set(values)
      .where(and(eq(sandboxes.appSessionId, appSessionId), eq(sandboxes.state, "starting"),
        eq(sandboxes.waitGeneration, wait.generation)));
  } catch (error) {
    console.error("[sandbox] reservation_release_failed", errorStatus(error) ?? "db");
  }
}

/** Неудачное создание не должно держать место в пуле пять минут. */
function releaseReservation(appSessionId: string, wait: SandboxWait): Promise<void> {
  return updateReservation(appSessionId, { state: "gone", startingSince: null, startingKind: null }, wait);
}

/**
 * Снимает резерв с неудавшегося пробуждения, не теряя саму машину: следующее
 * обращение снова попробует её запустить.
 */
function clearLaunchReservation(appSessionId: string, wait: SandboxWait): Promise<void> {
  return updateReservation(appSessionId, { startingSince: null, startingKind: null }, wait);
}

/**
 * Записывает машину в строку сессии, только если ключ ещё не удалён. Замок на
 * строке ключа сериализует это с `deleteKey`: либо машина попадёт в строку и
 * удаление увидит её id, либо удаление уже зафиксировано и машина уходит в
 * pending. Возвращает `false`, если ключ успели удалить.
 */
async function checkpointMachine(
  appSessionId: string,
  keyId: string,
  machine: DaytonaMachine,
  wait: SandboxWait,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [key] = await tx
      .select({ id: daytonaKeys.id })
      .from(daytonaKeys)
      .where(and(
        eq(daytonaKeys.id, keyId),
        isNull(daytonaKeys.deletedAt),
        ne(daytonaKeys.apiKeyEncrypted, DELETED_KEY_MARKER),
      ))
      .for("update");
    if (key === undefined) return false;
    const updated = await tx
      .update(sandboxes)
      .set({
        daytonaKeyId: keyId,
        daytonaSandboxId: machine.id,
        state: sandboxState(machine.state),
        startingSince: null,
        startingKind: null,
        lastActiveAt: new Date(),
        daytonaActivityAt: machine.lastActivityAt ?? null,
        stoppedAt: null,
        waitGeneration: wait.generation,
        launchStartedAt: null,
      })
      .where(and(eq(sandboxes.appSessionId, appSessionId), sqlExpression`
        ${sandboxes.waitGeneration} <= ${wait.generation} and (
          ${sandboxes.waitGeneration} = ${wait.generation} or exists (
            select 1 from app_sessions where id = ${appSessionId}
              and sandbox_wait_generation = ${wait.generation}))`))
      .returning({ id: sandboxes.id });
    return updated.length > 0;
  });
}

/**
 * Машину, созданную на уже удалённом ключе, нельзя оставлять сессии: она
 * сразу попадает в pending, чтобы повторный `deleteKey` её нашёл, даже если
 * удаление сейчас сорвётся.
 */
async function discardMachine(keyId: string, machine: DaytonaMachine): Promise<void> {
  await rememberPendingDeletion(keyId, machine.id);
  try {
    await machine.delete();
    await forgetPendingDeletion(keyId, machine.id);
  } catch (error) {
    console.error("[sandbox] cleanup_pending", errorStatus(error) ?? "transport");
  }
}

function sandboxStateForLoss(state: string | undefined) {
  return state === "destroyed" || state === "destroying";
}

async function connected(machine: DaytonaMachine, appSessionId: string, wait: SandboxWait): Promise<SandboxConnection> {
  await waitForSandboxMaintenance(appSessionId);
  await assertSandboxWait(wait);
  const db = getDb();
  const identity = and(eq(sandboxes.appSessionId, appSessionId), eq(sandboxes.daytonaSandboxId, machine.id));
  const updated = await db.update(sandboxes)
    .set({ state: sandboxState(machine.state), startingSince: null, startingKind: null,
      lastActiveAt: new Date(), daytonaActivityAt: machine.lastActivityAt ?? null, stoppedAt: null,
      waitGeneration: wait.generation, launchStartedAt: null })
    .where(and(identity, sqlExpression`exists (select 1 from app_sessions
      where id = ${appSessionId} and sandbox_wait_generation = ${wait.generation})`))
    .returning({ id: sandboxes.id });
  if (!updated.length) throw new StudioSandboxError("sandbox_wait_cancelled");
  const connection = machine.connect({
    async onStop() {
      await db.update(sandboxes)
        .set({ state: "stopped", startingSince: null, startingKind: null, stoppedAt: new Date() })
        .where(identity);
    },
    async onActivity() {
      await db.update(sandboxes).set({ lastActiveAt: new Date() })
        .where(and(identity, lt(sandboxes.lastActiveAt, new Date(Date.now() - 30_000))));
    },
  });
  return protectConnection(connection);
}

function protectConnection(connection: SandboxConnection): SandboxConnection {
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // edit_file отличает каталог от прочих отказов по коду EISDIR.
      if (error instanceof Error && "code" in error && error.code === "EISDIR") throw error;
      throw sandboxFailure(error, "sandbox_start_failed");
    }
  }
  return {
    workspaceRoot: connection.workspaceRoot,
    spawn: (options) => safe(async () => {
      const process = await connection.spawn(options);
      return { ...process, wait: () => safe(() => process.wait()), kill: () => safe(() => process.kill()) };
    }),
    readFile: (options) => safe(() => connection.readFile(options)),
    writeFiles: (options) => safe(() => connection.writeFiles(options)),
    removePath: (options) => safe(() => connection.removePath(options)),
    stop: () => safe(() => connection.stop()),
    close: () => safe(async () => { await connection.close?.(); }),
  };
}

async function seed(connection: SandboxConnection, artifact: Readonly<Artifact>) {
  if (artifact.files.length === 0) return;
  const process = await connection.spawn({ command: 'printf \'%s\\n\' "$HOME"', env: {}, workingDirectory: "/workspace" });
  const [stdout, , result] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.wait(),
  ]);
  const home = stdout.trim();
  const destination = result.exitCode === 0 && home.startsWith("/") ? home : "/workspace";
  await connection.writeFiles({ files: artifact.files.map((file) => ({
    path: file.path.startsWith(`${HOME_MARKER}/`)
      ? destination === "/workspace" ? file.path.replace(`${HOME_MARKER}/.agents/skills/`, "/workspace/skills/") : destination + file.path.slice(HOME_MARKER.length)
      : file.path,
    content: Buffer.from(file.content, "base64"),
  })) });
}

async function provision(
  backend: DaytonaBackend, name: string, appSessionId: string,
  artifact: Readonly<Artifact>, wait: SandboxWait, previousId?: string,
) {
  let machine: DaytonaMachine | undefined;
  try {
    const found = await backend.get(name);
    await assertSandboxWait(wait);
    if (found.id === previousId) await found.delete();
    else machine = await liveMachine(backend, found.id,
      () => beginSandboxLaunch(wait), () => assertSandboxWait(wait));
  } catch (error) {
    if (!isMissingSandbox(error) && !(error instanceof SandboxSessionGoneError)) throw error;
  }
  try {
    if (!machine) {
      await beginSandboxLaunch(wait);
      machine = await backend.create({ name, appSessionId, dockerfile: artifact.dockerfile });
    }
    if (machine.state === "build_failed") throw new StudioSandboxError("sandbox_create_failed");
    // No database checkpoint means no tool has used this machine yet. Reapply
    // seeds even after a crash between native creation and initial file delivery.
    const connection = protectConnection(machine.connect({ onStop: async () => {}, onActivity: async () => {} }));
    try { await seed(connection, artifact); }
    finally { await connection.close?.(); }
    return machine;
  } catch (error) {
    if (error instanceof StudioSandboxError && error.code === "sandbox_wait_cancelled") throw error;
    let cleanupFailed = false;
    try { await (await backend.get(name)).delete(); }
    catch (cleanupError) {
      if (!isMissingSandbox(cleanupError)) {
        sandboxFailure(cleanupError, "sandbox_create_failed");
        cleanupFailed = true;
      }
    }
    // Исходная ошибка решает, исчерпана ли квота или отозван ключ; коды
    // Daytona наружу не уходят — их разбирает вызывающий.
    if (cleanupFailed) throw new KeepReservationError(error);
    throw error;
  }
}

export function createDaytonaLifecycle() {
  return {
    async prepare(ctx: SandboxPrepareContext): Promise<Artifact> {
      const dockerfile = await ctx.files.readText("Dockerfile");
      const files: Artifact["files"] = [];
      const unsupported = async (): Promise<never> => { throw new Error("Подготовка образа допускает только запись файлов."); };
      await ctx.populate({
        workspaceRoot: "/workspace",
        async spawn({ command }) {
          if (command !== 'printf \'%s\\n\' "$HOME"') return unsupported();
          const stream = (value: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(value)); controller.close(); } });
          return { stdout: stream(`${HOME_MARKER}\n`), stderr: stream(""), wait: async () => ({ exitCode: 0 }), kill: async () => {} };
        },
        async writeFiles({ files: batch }) {
          files.push(...batch.map((file) => ({ path: file.path, content: Buffer.from(file.content).toString("base64") })));
        },
        readFile: unsupported, removePath: unsupported, stop: unsupported,
      });
      return { templateKey: ctx.templateKey({ dockerfile, version: 1 }), dockerfile, files };
    },
    async start(ctx: SandboxSessionContext, _options: undefined, artifact: Readonly<Artifact>) {
      const session = await boundSession(ctx.session.id, ctx.session.auth);
      const wait = ctx.session.parent
        ? await readSandboxCopyWait(session, ctx.session.parent.callId, ctx.session.turn.id)
        : await captureSandboxWait(session, ctx.session.turn.id);
      const deadline = Date.now() + loadConfig().sandboxQueueMaxWaitSeconds * 1000;
      while (true) {
        await assertSandboxWait(wait);
        if (Date.now() >= deadline) throw new StudioSandboxError("sandbox_queue_timeout");
        const [row] = await getDb().select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
        if (row && row.state !== "gone" && row.daytonaSandboxId === "") {
          // Восстановление/уборка машины до нового резерва: иначе смена ключа
          // затрёт единственный след машины, созданной перед падением процесса.
          try { return await openWithSlot(undefined); }
          catch (error) {
            if (!(error instanceof StudioSandboxError) || error.code !== "capacity_exhausted") throw error;
          }
        }
        let grant: DaytonaKey | undefined;
        let needsSlot = true;
        let launch: SandboxLaunch = "create";
        if (row && row.state !== "gone") {
          try {
            const backend = await backendFor(row.daytonaKeyId);
            const name = daytonaSandboxName(ctx.session.id);
            const machine = await backend.get(row.daytonaSandboxId || name);
            needsSlot = machine.state !== "started";
            launch = row.daytonaSandboxId
              ? machine.state === "archived" || machine.state === "archiving" ? "restore" : "wake"
              : "create";
          } catch (error) {
            if (errorStatus(error) === 401) {
              await markKeyUnauthorized(row.daytonaKeyId);
            } else if (!isMissingSandbox(error) && !(error instanceof SandboxSessionGoneError)) {
              throw sandboxFailure(error, "sandbox_start_failed");
            }
          }
        }
        if (needsSlot) {
          try {
            grant = await awaitSlot(session, launch,
              launch === "create" ? undefined : row?.daytonaKeyId,
              { maxWaitSeconds: Math.max(0, (deadline - Date.now()) / 1000), wait });
          } catch (error) {
            if (launch === "create" && error instanceof SandboxSessionGoneError) {
              await releaseReservation(session.id, wait);
              continue;
            }
            throw error;
          }
        }
        try { return await openWithSlot(grant); }
        catch (error) {
          if (!(error instanceof StudioSandboxError) || error.code !== "capacity_exhausted") throw error;
        }
      }

      async function openWithSlot(grant: DaytonaKey | undefined) {
        const sql = await getLockSqlClient().reserve();
        let locked = false;
        let opened: { machine: DaytonaMachine; state: State } | undefined;
        try {
          await sql`select pg_advisory_lock(1, hashtext(${session.id}::text))`;
          locked = true;
          await assertSandboxWait(wait);
          const [existing] = await sql<{ id: string; daytonaKeyId: string; daytonaSandboxId: string; state: StoredState }[]>`
            select id, daytona_key_id as "daytonaKeyId", daytona_sandbox_id as "daytonaSandboxId", state
            from sandboxes where app_session_id = ${session.id}`;
          if (existing !== undefined && existing.state !== "gone" && existing.daytonaSandboxId !== "") {
            try {
              const [key] = await sql<Pick<DaytonaKey, "id" | "apiKeyEncrypted" | "deletedAt">[]>`
                select id, api_key_encrypted as "apiKeyEncrypted", deleted_at as "deletedAt"
                from daytona_keys where id = ${existing.daytonaKeyId}`;
              const backend = backendForKey(key);
              const machine = await liveMachine(
                backend,
                existing.daytonaSandboxId,
                async (kind) => {
                  if (!grant) throw new StudioSandboxError("capacity_exhausted");
                  await reserveLaunch(session.id, existing.daytonaKeyId, kind, wait);
                  await beginSandboxLaunch(wait);
                },
                () => assertSandboxWait(wait),
              );
              opened = { machine, state: { keyId: existing.daytonaKeyId, sandboxId: machine.id } };
            } catch (error) {
              if (!(error instanceof SandboxSessionGoneError)) throw error;
              await sql`update sandboxes set state = 'gone' where id = ${existing.id}`;
            }
          }
          const name = daytonaSandboxName(ctx.session.id);
          const config = loadConfig();
          if (opened === undefined) {
            // Процесс мог упасть после создания машины, но до записи её id.
            // Имя детерминировано, поэтому сначала ищем её и только потом
            // требуем место у пула: иначе машина занимает последний слот, а
            // `pickKey` отвечает `capacity_exhausted`.
            if (existing !== undefined && existing.state !== "gone" && existing.daytonaSandboxId === "") {
              const [key] = await sql<Pick<DaytonaKey, "id" | "apiKeyEncrypted" | "deletedAt">[]>`
                select id, api_key_encrypted as "apiKeyEncrypted", deleted_at as "deletedAt"
                from daytona_keys where id = ${existing.daytonaKeyId}`;
              if (key !== undefined && key.apiKeyEncrypted !== DELETED_KEY_MARKER) {
                const backend = daytonaBackend(
                  key.id,
                  decryptSecret(key.apiKeyEncrypted, config.secretsEncryptionKey, DAYTONA_KEY_PURPOSE),
                );
                // У мягко удалённого ключа шифротекст ещё есть: созданную до
                // падения машину нужно найти и убрать, а не оставить сиротой.
                const deleted = key.deletedAt !== null;
                try {
                  const found = await backend.get(name);
                  if (deleted) {
                    // Машину удалённого ключа не будим и не сеем: сразу в очистку.
                    await discardMachine(key.id, found);
                  } else {
                    if (found.state !== "started" && !grant) {
                      throw new StudioSandboxError("capacity_exhausted");
                    }
                    const machine = await provision(
                      backend,
                      name,
                      session.id,
                      artifact,
                      wait,
                      existing.daytonaSandboxId,
                    );
                    if (await checkpointMachine(session.id, key.id, machine, wait)) {
                      opened = { machine, state: { keyId: key.id, sandboxId: machine.id } };
                    } else {
                      await assertSandboxWait(wait);
                      await discardMachine(key.id, machine);
                    }
                  }
                } catch (error) {
                  if (isMissingSandbox(error)) {
                    // Машины по имени нет — обычный путь создания.
                  } else if (errorStatus(error) === 401) {
                    // Ключ отозван: помечаем и переходим к следующему, иначе
                    // пустой резерв будет вечно повторять этот же отказ.
                    await markKeyUnauthorized(key.id);
                  } else {
                    throw error;
                  }
                }
              }
            }

            if (opened === undefined) {
              let created: DaytonaMachine | undefined;
              try {
                if (!grant) throw new StudioSandboxError("capacity_exhausted");
                const backend = backendForKey(grant);
                try {
                  created = await provision(backend, name, session.id, artifact, wait, existing?.daytonaSandboxId);
                } catch (error) {
                  if (isQuotaExceeded(error)) {
                    await exhaustPool(grant.id);
                    throw new StudioSandboxError("capacity_exhausted");
                  }
                  if (errorStatus(error) === 401) {
                    await markKeyUnauthorized(grant.id);
                    throw new StudioSandboxError("capacity_exhausted");
                  }
                  throw error;
                }
                if (await checkpointMachine(session.id, grant.id, created, wait)) {
                  opened = { machine: created, state: { keyId: grant.id, sandboxId: created.id } };
                  created = undefined;
                } else {
                  await assertSandboxWait(wait);
                  await discardMachine(grant.id, created);
                  created = undefined;
                  throw new StudioSandboxError("capacity_exhausted");
                }
              } catch (error) {
                // Если машина уже создана, но запись id или очистка после сбоя
                // сорвалась, резерв оставляем восстановимым по имени.
                if (created === undefined && !(error instanceof KeepReservationError)) {
                  await releaseReservation(session.id, wait);
                } else {
                  await clearLaunchReservation(session.id, wait);
                }
                throw error;
              }
            }
          }
        } catch (error) {
          await clearLaunchReservation(session.id, wait);
          if (grant && isQuotaExceeded(error)) {
            await exhaustPool(grant.id);
            throw new StudioSandboxError("capacity_exhausted");
          }
          throw sandboxFailure(error, "sandbox_create_failed");
        }
        finally {
          try { if (locked) await sql`select pg_advisory_unlock(1, hashtext(${session.id}::text))`; }
          finally { await sql.release(); }
        }
        if (opened === undefined) throw new StudioSandboxError("sandbox_create_failed");
        return { state: opened.state, connection: await connected(opened.machine, session.id, wait) };
      }
    },
    async resume(ctx: SandboxSessionContext, _artifact: Readonly<Artifact>, state: Readonly<State>) {
      if (
        !state || typeof state !== "object" ||
        typeof state.keyId !== "string" || state.keyId.length === 0 ||
        typeof state.sandboxId !== "string" || state.sandboxId.length === 0
      ) throw new SandboxSessionGoneError("Некорректное состояние песочницы.");
      const session = await boundSession(ctx.session.id, ctx.session.auth);
      const wait = ctx.session.parent
        ? await readSandboxCopyWait(session, ctx.session.parent.callId, ctx.session.turn.id)
        : await captureSandboxWait(session, ctx.session.turn.id);
      const deadline = Date.now() + loadConfig().sandboxQueueMaxWaitSeconds * 1000;
      while (true) {
        await assertSandboxWait(wait);
        if (Date.now() >= deadline) throw new StudioSandboxError("sandbox_queue_timeout");
        try {
          await waitForSandboxMaintenance(session.id);
          const backend = await backendFor(state.keyId);
          const machine = await liveMachine(
            backend,
            state.sandboxId,
            async (kind) => {
              await awaitSlot(
                session,
                kind,
                state.keyId,
                { maxWaitSeconds: Math.max(0, (deadline - Date.now()) / 1000), wait },
              );
              const lock = await getLockSqlClient().reserve();
              let locked = false;
              try {
                await lock`select pg_advisory_lock(1, hashtext(${session.id}::text))`;
                locked = true;
                return await liveMachine(
                  backend, state.sandboxId,
                  () => beginSandboxLaunch(wait),
                  () => assertSandboxWait(wait),
                );
              } finally {
                try {
                  if (locked) await lock`select pg_advisory_unlock(1, hashtext(${session.id}::text))`;
                } finally {
                  lock.release();
                }
              }
            },
            () => assertSandboxWait(wait),
          );
          return await connected(machine, session.id, wait);
        } catch (error) {
          if (error instanceof SandboxSessionGoneError) {
            await getDb().update(sandboxes).set({ state: "gone" })
              .where(and(eq(sandboxes.appSessionId, session.id), eq(sandboxes.daytonaSandboxId, state.sandboxId)));
            throw error;
          }
          await clearLaunchReservation(session.id, wait);
          if (isQuotaExceeded(error)) {
            await exhaustPool(state.keyId);
            continue;
          }
          throw sandboxFailure(error, "sandbox_start_failed");
        }
      }
    },
    async onSessionEnd(ctx: SandboxSessionContext, state: Readonly<State> | null, options: SandboxSessionEndOptions) {
      options.abortSignal?.throwIfAborted();
      const [session] = await getDb().select().from(appSessions).where(eq(appSessions.eveSessionId, ctx.session.id));
      if (session === undefined) return;
      const [row] = await getDb().select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
      const target = state ?? (row ? { keyId: row.daytonaKeyId, sandboxId: row.daytonaSandboxId } : null);
      if (target === null) return;
      try {
        const [key] = await abortable(() => getDb().select().from(daytonaKeys).where(eq(daytonaKeys.id, target.keyId)), options.abortSignal);
        // Удалённый ключ уже не расшифровывается: машин этого ключа больше нет.
        if (key !== undefined && key.apiKeyEncrypted === DELETED_KEY_MARKER) {
          await getDb().update(sandboxes).set({ state: "gone" }).where(eq(sandboxes.appSessionId, session.id));
          return;
        }
        const backend = backendForKey(key, true);
        const machine = await abortable(() => backend.get(target.sandboxId), options.abortSignal);
        await abortable(() => machine.delete(), options.abortSignal);
      }
      catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (!(error instanceof SandboxSessionGoneError) && !isMissingSandbox(error)) throw sandboxFailure(error, "sandbox_start_failed");
      }
      await getDb().update(sandboxes).set({ state: "gone" }).where(eq(sandboxes.appSessionId, session.id));
    },
  };
}

export const DaytonaSandbox = defineSandboxProvider({
  name: "studio-daytona", stateProtocolVersion: 1, environment: createDaytonaLifecycle,
});
