/**
 * Предел `MEDIA_COPY_MAX_BYTES` читает хук в процессе eve (#8). У основного
 * экземпляра окружение eve зафиксировано на старте, поэтому этот файл
 * поднимает свой сервер eve с пределом 1000 байт. HTTP-список файлов
 * читает основной экземпляр приложения из той же тестовой базы.
 */
import { expect, test } from "vitest";

import { createSessionAs, eveClientAs, readStreamUntil } from "./support/chat";
import { createDaytonaKey, createUser, resetDatabase } from "./support/db";
import { startEveDev } from "./support/eve-dev";
import { fakeSandbox } from "./support/fake-sandbox";
import { waitForSessionFiles } from "./support/media";

test("файл больше предела не копируется и остаётся too_large", async () => {
  await resetDatabase();
  await fakeSandbox.reset();
  await createDaytonaKey();

  const eve = await startEveDev({
    MEDIA_COPY_MAX_BYTES: "1000",
    EVE_DEV_STATE_DIR: `.tmp/eve-media-limit-${process.pid}`,
  });
  try {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "out/big.mp4": new Uint8Array(2000) });

    const client = await eveClientAs(user, id, { baseUrl: eve.url });
    const response = (await client.sessions.create({ message: "Вот ![кадр](out/big.mp4)" }))
      .response;
    await readStreamUntil(response, "session.waiting");

    const files = await waitForSessionFiles(
      user,
      id,
      (items) => items.length === 1 && items[0]?.state !== "copying",
      { timeoutMs: 20_000 },
    );
    expect(files).toEqual([
      expect.objectContaining({
        path: "/workspace/out/big.mp4",
        state: "missing",
        reason: "too_large",
      }),
    ]);
  } finally {
    await eve.stop();
  }
}, 300_000);
