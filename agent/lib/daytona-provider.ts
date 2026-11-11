import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { and, eq, isNull, lt, ne } from "drizzle-orm";
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
import { daytonaBackend, type DaytonaBackend, type DaytonaMachine } from "./daytona-backend";
import {
  DELETED_KEY_MARKER,
  enabledKeyCount,
  exhaustPool,
  forgetPendingDeletion,
  isQuotaExceeded,
  markKeyUnauthorized,
  pickKey,
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
type StoredState = "started" | "stopped" | "archived" | "starting" | "gone";

export function sandboxState(state: string | undefined): StoredState {
  switch (state) {
    case "started": return "started";
    case "stopped": case "stopping": return "stopped";
    case "archived": case "archiving": return "archived";
    case "destroyed": case "destroying": return "gone";
    case "creating": case "starting": case "restoring": case "pending_build":
    case "building_snapshot": case "pulling_snapshot": case "resizing":
    case "snapshotting": case "forking": case "resuming": return "starting";
    case "error": case "build_failed": throw new StudioSandboxError("sandbox_start_failed");
    default:
      console.warn("[sandbox] unexpected_state");
      return "starting";
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
  onLaunch?: (kind: SandboxLaunch) => Promise<void>,
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
  if (sandboxStateForLoss(machine.state)) throw new SandboxSessionGoneError("Песочница утрачена.");
  if (machine.state === "error" || machine.state === "build_failed") {
    if (machine.state === "error" && machine.recoverable) {
      await onLaunch?.("restore");
      await machine.recover();
    } else {
      await machine.delete();
      throw new SandboxSessionGoneError("Песочница утрачена.");
    }
  } else if (machine.state === "stopped" || machine.state === "archived") {
    // Строка `starting` резервирует место в квоте, пока Daytona не покажет
    // запущенную машину: её данные отстают от изменения.
    await onLaunch?.(machine.state === "archived" ? "restore" : "wake");
    await machine.start();
  } else if (machine.state !== "started") {
    sandboxState(machine.state);
    await machine.ready();
  }
  return machine;
}

/** Резерв места в пуле до того, как Daytona обновит использование. */
async function reserveLaunch(appSessionId: string, keyId: string, kind: SandboxLaunch): Promise<void> {
  await getDb()
    .update(sandboxes)
    .set({ daytonaKeyId: keyId, state: "starting", startingSince: new Date(), startingKind: kind })
    .where(eq(sandboxes.appSessionId, appSessionId));
}

/** Снимает резерв; сбой записи не должен подменять исходную ошибку старта. */
async function updateReservation(
  appSessionId: string,
  values: { state?: "gone"; startingSince: null; startingKind: null },
): Promise<void> {
  try {
    await getDb()
      .update(sandboxes)
      .set(values)
      .where(and(eq(sandboxes.appSessionId, appSessionId), eq(sandboxes.state, "starting")));
  } catch (error) {
    console.error("[sandbox] reservation_release_failed", errorStatus(error) ?? "db");
  }
}

/** Неудачное создание не должно держать место в пуле пять минут. */
function releaseReservation(appSessionId: string): Promise<void> {
  return updateReservation(appSessionId, { state: "gone", startingSince: null, startingKind: null });
}

/**
 * Снимает резерв с неудавшегося пробуждения, не теряя саму машину: следующее
 * обращение снова попробует её запустить.
 */
function clearLaunchReservation(appSessionId: string): Promise<void> {
  return updateReservation(appSessionId, { startingSince: null, startingKind: null });
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
    await tx
      .update(sandboxes)
      .set({
        daytonaKeyId: keyId,
        daytonaSandboxId: machine.id,
        state: sandboxState(machine.state),
        startingSince: null,
        startingKind: null,
        lastActiveAt: new Date(),
      })
      .where(eq(sandboxes.appSessionId, appSessionId));
    return true;
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

async function connected(machine: DaytonaMachine, appSessionId: string): Promise<SandboxConnection> {
  const db = getDb();
  const identity = and(eq(sandboxes.appSessionId, appSessionId), eq(sandboxes.daytonaSandboxId, machine.id));
  await db.update(sandboxes)
    .set({ state: sandboxState(machine.state), startingSince: null, startingKind: null, lastActiveAt: new Date() })
    .where(identity);
  const connection = machine.connect({
    async onStop() {
      await db.update(sandboxes)
        .set({ state: "stopped", startingSince: null, startingKind: null })
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

async function provision(backend: DaytonaBackend, name: string, appSessionId: string, artifact: Readonly<Artifact>, previousId?: string) {
  let machine: DaytonaMachine | undefined;
  try {
    const found = await backend.get(name);
    if (found.id === previousId) await found.delete();
    else machine = await liveMachine(backend, found.id);
  } catch (error) {
    if (!isMissingSandbox(error) && !(error instanceof SandboxSessionGoneError)) throw error;
  }
  try {
    machine ??= await backend.create({ name, appSessionId, dockerfile: artifact.dockerfile });
    if (machine.state === "build_failed") throw new StudioSandboxError("sandbox_create_failed");
    // No database checkpoint means no tool has used this machine yet. Reapply
    // seeds even after a crash between native creation and initial file delivery.
    const connection = protectConnection(machine.connect({ onStop: async () => {}, onActivity: async () => {} }));
    try { await seed(connection, artifact); }
    finally { await connection.close?.(); }
    return machine;
  } catch (error) {
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
      const sql = await getLockSqlClient().reserve();
      let locked = false;
      let opened: { machine: DaytonaMachine; state: State } | undefined;
      try {
        await sql`select pg_advisory_lock(1, hashtext(${session.id}::text))`;
        locked = true;
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
              (kind) => reserveLaunch(session.id, existing.daytonaKeyId, kind),
            );
            opened = { machine, state: { keyId: existing.daytonaKeyId, sandboxId: machine.id } };
          } catch (error) {
            if (!(error instanceof SandboxSessionGoneError)) throw error;
            await sql`update sandboxes set state = 'gone' where id = ${existing.id}`;
          }
        }
        const name = `studio-${createHash("sha256").update(ctx.session.id).digest("hex").slice(0, 32)}`;
        const config = loadConfig();
        if (opened === undefined) {
          const need = {
            cpu: config.sandboxCpu,
            memoryGb: config.sandboxMemoryGb,
            diskGb: config.sandboxDiskGb,
          };

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
                  const machine = await provision(
                    backend,
                    name,
                    session.id,
                    artifact,
                    existing.daytonaSandboxId,
                  );
                  if (await checkpointMachine(session.id, key.id, machine)) {
                    opened = { machine, state: { keyId: key.id, sandboxId: machine.id } };
                  } else {
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
            const attempts = Math.max(1, await enabledKeyCount());
            let lastError: unknown;
            let created: DaytonaMachine | undefined;
            try {
              for (let attempt = 0; attempt < attempts; attempt += 1) {
                const picked = await pickKey(need, { appSessionId: session.id });
                if (picked.kind === "no_key") throw new StudioSandboxError("no_daytona_key");
                if (picked.kind === "no_capacity") throw new StudioSandboxError("capacity_exhausted");
                const secret = decryptSecret(
                  picked.key.apiKeyEncrypted,
                  config.secretsEncryptionKey,
                  DAYTONA_KEY_PURPOSE,
                );
                const backend = daytonaBackend(picked.key.id, secret);
                let machine: DaytonaMachine;
                try {
                  machine = await provision(backend, name, session.id, artifact, existing?.daytonaSandboxId);
                } catch (error) {
                  lastError = error;
                  // Исчерпанная квота Daytona — сигнал пулу на 60 секунд; отозванный
                  // ключ (401) выбывает из выбора, остальные ошибки не помечают ключ.
                  if (isQuotaExceeded(error)) { await exhaustPool(picked.key.id); continue; }
                  if (errorStatus(error) === 401) { await markKeyUnauthorized(picked.key.id); continue; }
                  throw error;
                }
                created = machine;
                const state = { keyId: picked.key.id, sandboxId: machine.id };
                if (await checkpointMachine(session.id, picked.key.id, machine)) {
                  opened = { machine, state };
                  created = undefined;
                  break;
                }
                await discardMachine(picked.key.id, machine);
                created = undefined;
              }
            } catch (error) {
              // Если машина уже создана, но запись id или очистка после сбоя
              // сорвалась, резерв оставляем восстановимым по имени.
              if (created === undefined && !(error instanceof KeepReservationError)) {
                await releaseReservation(session.id);
              } else {
                await clearLaunchReservation(session.id);
              }
              throw error;
            }
            if (opened === undefined) {
              await releaseReservation(session.id);
              // Последняя попытка тоже упёрлась в квоту: места нет, а не сбой сборки.
              if (isQuotaExceeded(lastError)) throw new StudioSandboxError("capacity_exhausted");
              throw sandboxFailure(lastError ?? new StudioSandboxError("sandbox_create_failed"), "sandbox_create_failed");
            }
          }
        }
      } catch (error) {
        await clearLaunchReservation(session.id);
        throw sandboxFailure(error, "sandbox_create_failed");
      }
      finally {
        try { if (locked) await sql`select pg_advisory_unlock(1, hashtext(${session.id}::text))`; }
        finally { await sql.release(); }
      }
      if (opened === undefined) throw new StudioSandboxError("sandbox_create_failed");
      return { state: opened.state, connection: await connected(opened.machine, session.id) };
    },
    async resume(ctx: SandboxSessionContext, _artifact: Readonly<Artifact>, state: Readonly<State>) {
      if (
        !state || typeof state !== "object" ||
        typeof state.keyId !== "string" || state.keyId.length === 0 ||
        typeof state.sandboxId !== "string" || state.sandboxId.length === 0
      ) throw new SandboxSessionGoneError("Некорректное состояние песочницы.");
      const session = await boundSession(ctx.session.id, ctx.session.auth);
      try {
        const backend = await backendFor(state.keyId);
        const machine = await liveMachine(
          backend,
          state.sandboxId,
          (kind) => reserveLaunch(session.id, state.keyId, kind),
        );
        return await connected(machine, session.id);
      } catch (error) {
        if (error instanceof SandboxSessionGoneError) {
          await getDb().update(sandboxes).set({ state: "gone" })
            .where(and(eq(sandboxes.appSessionId, session.id), eq(sandboxes.daytonaSandboxId, state.sandboxId)));
          throw error;
        }
        await clearLaunchReservation(session.id);
        throw sandboxFailure(error, "sandbox_start_failed");
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
