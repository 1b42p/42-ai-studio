/**
 * Медиа вызова инструмента (#8): `publishToolMedia` копирует файл из песочницы
 * один раз на пару «вызов, путь», а ошибки не оставляют строк.
 */
import { randomUUID } from "node:crypto";
import type {
  SandboxReadFileOptions,
  SandboxRunOptions,
  SandboxSession,
} from "eve/sandbox";
import { beforeEach, describe, expect, test } from "vitest";

import { loadConfig } from "../../lib/config";
import { appSessions, media, toolCallMedia } from "../../lib/db/schema";
import { copySandboxFile } from "../../lib/media/copy";
import { publishToolMedia } from "../../lib/media/publish-tool-media";
import { getFakeBackend, type FakeMachine } from "../../lib/sandbox/fake";
import { createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { s3 } from "./support/s3";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
  await s3().deletePrefix("");
});

/** Минимальная сессия песочницы: публикации нужны `run` и `readFile`. */
function sessionFrom(machine: FakeMachine): SandboxSession {
  const connection = machine.connect({ onActivity: async () => {}, onStop: async () => {} });
  return {
    async run({ command, abortSignal }: SandboxRunOptions) {
      const process = await connection.spawn({
        command,
        abortSignal,
        env: {},
        workingDirectory: "/workspace",
      });
      const [stdout, stderr, result] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.wait(),
      ]);
      return { exitCode: result.exitCode, stderr, stdout };
    },
    readFile: (options: SandboxReadFileOptions) => connection.readFile(options),
  } as unknown as SandboxSession;
}

async function bindSession(userId: string, eveSessionId: string): Promise<string> {
  const [session] = await db()
    .insert(appSessions)
    .values({ userId, eveSessionId })
    .returning();
  return session!.id;
}

async function machineFor(appSessionId: string): Promise<FakeMachine> {
  const backend = getFakeBackend(loadConfig().fakeSandboxDir!);
  return backend.create({
    name: `tool-media-${randomUUID()}`,
    appSessionId,
  });
}

describe("publishToolMedia", () => {
  test("повторный вызов с тем же callId и путём не создаёт вторую строку", async () => {
    const user = await createUser();
    const appSessionId = await bindSession(user.id, "evt_root");
    const bytes = new TextEncoder().encode("дорожка озвучки");
    await fakeSandbox.seed(appSessionId, { "out/voice.mp3": bytes });
    const machine = await machineFor(appSessionId);
    const sandbox = sessionFrom(machine);
    const ctx = {
      session: { id: "evt_root" },
      callId: "call_voice",
      getSandbox: async () => sandbox,
    };

    const first = await publishToolMedia(ctx, { path: "out/voice.mp3" });
    const second = await publishToolMedia(ctx, { path: "out/voice.mp3" });

    expect(second.mediaId).toBe(first.mediaId);
    const mediaRows = await db().select().from(media);
    const links = await db().select().from(toolCallMedia);
    expect(mediaRows).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(links[0]?.mediaId).toBe(first.mediaId);
    expect(links[0]?.callId).toBe("call_voice");
    expect(mediaRows[0]?.kind).toBe("tool_media");
    expect(mediaRows[0]?.contentType).toBe("audio/mpeg");
    expect(mediaRows[0]?.objectKey).toContain(
      `u/${user.id}/s/${appSessionId}/tool-media/`,
    );

    const keys = await s3().listKeys(`u/${user.id}/`);
    expect(keys).toHaveLength(1);
    expect(await s3().getBytes(keys[0]!)).toEqual(bytes);
  }, 30_000);

  test("пустой файл тоже копируется", async () => {
    const user = await createUser();
    const appSessionId = await bindSession(user.id, "evt_empty");
    await fakeSandbox.seed(appSessionId, { "out/empty.txt": new Uint8Array() });
    const machine = await machineFor(appSessionId);
    const sandbox = sessionFrom(machine);

    await publishToolMedia(
      {
        session: { id: "evt_empty" },
        callId: "call_empty",
        getSandbox: async () => sandbox,
      },
      { path: "out/empty.txt" },
    );

    const [row] = await db().select().from(media);
    expect(row?.sizeBytes).toBe(0);
    expect(row?.contentType).toBe("text/plain");
    expect(await s3().getBytes(row!.objectKey)).toEqual(new Uint8Array());
  }, 30_000);

  test("одинарная кавычка в имени файла не ломает команды песочницы", async () => {
    const user = await createUser();
    const appSessionId = await bindSession(user.id, "evt_quote");
    await fakeSandbox.seed(appSessionId, { "out/it's.txt": new Uint8Array([7]) });
    const machine = await machineFor(appSessionId);
    const sandbox = sessionFrom(machine);

    const result = await publishToolMedia(
      {
        session: { id: "evt_quote" },
        callId: "call_quote",
        getSandbox: async () => sandbox,
      },
      { path: "out/it's.txt" },
    );

    const [row] = await db().select().from(media);
    expect(row?.id).toBe(result.mediaId);
    expect(row?.originalName).toBe("it's.txt");
  }, 30_000);

  test("путь вне рабочей области и большой файл дают ошибки без строк", async () => {
    const user = await createUser();
    const appSessionId = await bindSession(user.id, "evt_errors");
    await fakeSandbox.seed(appSessionId, { "out/big.bin": new Uint8Array(10) });
    const machine = await machineFor(appSessionId);
    const sandbox = sessionFrom(machine);
    const ctx = {
      session: { id: "evt_errors" },
      callId: "call_error",
      getSandbox: async () => sandbox,
    };

    await expect(publishToolMedia(ctx, { path: "/etc/passwd" })).rejects.toMatchObject({
      name: "PublishToolMediaError",
      reason: "outside_workspace",
    });
    await expect(
      publishToolMedia(ctx, { path: "out/big.bin" }, { maxBytes: 4 }),
    ).rejects.toMatchObject({
      name: "PublishToolMediaError",
      reason: "too_large",
    });

    expect(await db().select().from(media)).toEqual([]);
    expect(await db().select().from(toolCallMedia)).toEqual([]);
    expect(await s3().listKeys("")).toEqual([]);
  }, 30_000);

  test("копия агента находит сессию по rootSessionId", async () => {
    const user = await createUser();
    const appSessionId = await bindSession(user.id, "evt_parent_root");
    await fakeSandbox.seed(appSessionId, { "out/frame.png": new Uint8Array([1, 2, 3]) });
    const machine = await machineFor(appSessionId);
    const sandbox = sessionFrom(machine);

    const result = await publishToolMedia(
      {
        session: { id: "evt_child", parent: { rootSessionId: "evt_parent_root" } },
        callId: "call_child",
        getSandbox: async () => sandbox,
      },
      { path: "out/frame.png", kind: "preview" },
    );

    const [row] = await db().select().from(media);
    expect(row?.appSessionId).toBe(appSessionId);
    expect(row?.kind).toBe("preview");
    expect(row?.contentType).toBe("image/png");
    expect(row?.objectKey).toContain(`/preview/`);
    const links = await db().select().from(toolCallMedia);
    expect(links[0]?.mediaId).toBe(result.mediaId);
  }, 30_000);

  test("счётчик прочитанных байт отвергает файл, совравший о размере", async () => {
    const user = await createUser();
    const appSessionId = await bindSession(user.id, "evt_honest");
    const sandbox = {
      async run({ command }: { command: string }) {
        if (command.startsWith("realpath")) {
          return { exitCode: 0, stderr: "", stdout: "/workspace/out/x.bin\n" };
        }
        return { exitCode: 0, stderr: "", stdout: "regular file|1\n" };
      },
      async readFile() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
            controller.close();
          },
        });
      },
    } as unknown as SandboxSession;

    await expect(
      copySandboxFile({
        sandbox,
        path: "/workspace/out/x.bin",
        maxBytes: 4,
        userId: user.id,
        appSessionId,
      }),
    ).rejects.toMatchObject({ name: "MediaCopyError", reason: "too_large" });

    expect(await s3().listKeys(`u/${user.id}/`)).toEqual([]);
  });

  test("без привязанной сессии — no_session", async () => {
    await expect(
      publishToolMedia(
        {
          session: { id: "evt_unknown" },
          callId: "call_none",
          getSandbox: async () => {
            throw new Error("не должна вызываться");
          },
        },
        { path: "out/x.mp4" },
      ),
    ).rejects.toMatchObject({ reason: "no_session" });
  });
});
