/**
 * Предел `MEDIA_COPY_MAX_BYTES` читает хук в процессе eve (#8). У основного
 * экземпляра окружение eve зафиксировано на старте, поэтому этот файл
 * поднимает свой сервер eve с пределом 1000 байт и приложение, которое
 * проксирует агент на него (`EVE_BASE_URL`).
 */
import { Client } from "eve/client";
import { expect, test } from "vitest";

import { startApp } from "./support/app";
import { loginAs } from "./support/auth";
import { readStreamUntil } from "./support/chat";
import { createDaytonaKey, createUser, resetDatabase } from "./support/db";
import { startEveDev } from "./support/eve-dev";
import { fakeSandbox } from "./support/fake-sandbox";
import { sleep } from "../../lib/sleep";

test("файл больше предела не копируется и остаётся too_large", async () => {
  await resetDatabase();
  await fakeSandbox.reset();
  await createDaytonaKey();

  const eve = await startEveDev({
    MEDIA_COPY_MAX_BYTES: "1000",
    EVE_DEV_STATE_DIR: `.tmp/eve-media-limit-${process.pid}`,
  });
  const app = await startApp({
    env: { EVE_BASE_URL: eve.url, MEDIA_COPY_MAX_BYTES: "1000" },
  });

  try {
    const user = await createUser();
    const cookie = await loginAs(user);
    const created = await fetch(new URL("/api/sessions", app.url), {
      method: "POST",
      headers: { cookie },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await fakeSandbox.seed(id, { "out/big.mp4": new Uint8Array(2000) });
    const client = new Client({
      host: app.url,
      redirect: "manual",
      headers: { cookie, "x-studio-session-id": id },
    });
    const response = (await client.sessions.create({ message: "Вот ![кадр](out/big.mp4)" }))
      .response;
    await readStreamUntil(response, "session.waiting");

    const deadline = Date.now() + 20_000;
    let files: Array<{ state: string; reason: string | null; path: string }> = [];
    while (Date.now() < deadline) {
      const list = await fetch(new URL(`/api/sessions/${id}/files`, app.url), {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      files = ((await list.json()) as { files: typeof files }).files;
      if (files.length === 1 && files[0]?.state !== "copying") break;
      await sleep(200);
    }

    expect(files).toEqual([
      expect.objectContaining({
        path: "/workspace/out/big.mp4",
        state: "missing",
        reason: "too_large",
      }),
    ]);
  } finally {
    await app.stop();
    await eve.stop();
  }
}, 300_000);
