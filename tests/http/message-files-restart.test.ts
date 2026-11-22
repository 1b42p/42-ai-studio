import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

import { media } from "../../lib/db/schema";
import { defaultMessageReducer } from "eve/client";
import { createSessionAs, eveClientAs, readStreamUntil } from "./support/chat";
import { createDaytonaKey, createUser, db } from "./support/db";
import { startEveDev } from "./support/eve-dev";
import { fakeSandbox } from "./support/fake-sandbox";
import { mediaRedirect, readSigned, waitForSessionFiles } from "./support/media";
import { s3 } from "./support/s3";

test("перезапуск eve продолжает незавершённую публикацию без нового сообщения", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const bytes = new TextEncoder().encode("ролик пережил перезапуск");
  const filePath = "out/final.mp4";
  await fakeSandbox.seed(id, { [filePath]: bytes });
  await fakeSandbox.rules.set([{ match: "^LC_ALL=C stat .*final\\.mp4", stdout: "regular file|1\n", delayMs: 120_000 }]);

  const env = {
    EVE_DEV_STATE_DIR: `.tmp/eve-media-restart-${randomUUID()}`,
    // После SIGKILL новый процесс ждёт истечения аренды шага Workflow.
    // Оставляем механизм включённым, но не ждём штатные 860 секунд в тесте.
    WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "10",
  };
  let eve = await startEveDev(env);
  try {
    const client = await eveClientAs(user, id, { baseUrl: eve.url });
    const { response, session } = await client.sessions.create({ message: `Вот [ролик](${filePath})` });
    await readStreamUntil(response, "message.completed");
    await waitForSessionFiles(user, id, (files) => files[0]?.state === "copying");
    await expect.poll(async () =>
      (await fakeSandbox.calls(id)).some((call) => call.command?.startsWith("LC_ALL=C stat")),
    { timeout: 15_000 }).toBe(true);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/`)).toEqual([]);

    await eve.crash();
    await fakeSandbox.rules.set([]);
    // eve start возобновляет активные запуски автоматически. У dev-сервера
    // восстановление запусков предыдущего процесса включается явно.
    eve = await startEveDev(env, { resume: true });

    const [file] = await waitForSessionFiles(user, id, (files) => files[0]?.state === "ready", {
      timeoutMs: 90_000,
    });
    const restarted = await eveClientAs(user, id, { baseUrl: eve.url });
    const events = await readStreamUntil(restarted.sessions.attach(session.state.sessionId).stream(), "session.waiting");
    expect(events.at(-1)?.type).toBe("session.waiting");
    const completed = events.filter((event) => event.type === "message.completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]?.data.stepIndex).toBe(completed[1]?.data.stepIndex);
    expect(completed[0]?.data.turnId).toBe(completed[1]?.data.turnId);
    expect(completed[0]?.meta.id).not.toBe(completed[1]?.meta.id);
    const reducer = defaultMessageReducer();
    const data = events.reduce(reducer.reduce, reducer.initial());
    expect(data.messages.flatMap((message) =>
      message.role === "assistant" ? message.parts.filter((part) => part.type === "text") : [],
    )).toHaveLength(2);
    expect(await db().select().from(media)).toHaveLength(1);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/`)).toHaveLength(1);
    const link = await mediaRedirect(user, file!.mediaId!, "?download=1");
    expect(link.status).toBe(302);
    expect(await readSigned(link.location!)).toEqual(bytes);
  } catch (error) {
    throw new Error(`Публикация после перезапуска Eve:\n${eve.output()}`, { cause: error });
  } finally {
    await fakeSandbox.rules.set([]);
    await eve.stop();
  }
}, 360_000);
