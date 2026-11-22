import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

import { media } from "../../lib/db/schema";
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

  const env = { EVE_DEV_STATE_DIR: `.tmp/eve-media-restart-${randomUUID()}` };
  let eve = await startEveDev(env);
  try {
    const client = await eveClientAs(user, id, { baseUrl: eve.url });
    const { response, session } = await client.sessions.create({ message: `Вот [ролик](${filePath})` });
    await readStreamUntil(response, "message.completed");
    await waitForSessionFiles(user, id, (files) => files[0]?.state === "copying");
    await expect.poll(async () =>
      (await fakeSandbox.calls(id)).some((call) => call.command?.startsWith("LC_ALL=C stat")),
    ).toBe(true);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/`)).toEqual([]);

    await eve.crash();
    await fakeSandbox.rules.set([]);
    eve = await startEveDev(env);

    const [file] = await waitForSessionFiles(user, id, (files) => files[0]?.state === "ready", {
      timeoutMs: 90_000,
    });
    const restarted = await eveClientAs(user, id, { baseUrl: eve.url });
    const events = await readStreamUntil(restarted.sessions.attach(session.state.sessionId).stream(), "session.waiting");
    expect(events.at(-1)?.type).toBe("session.waiting");
    expect(await db().select().from(media)).toHaveLength(1);
    expect(await s3().listKeys(`u/${user.id}/s/${id}/`)).toHaveLength(1);
    const link = await mediaRedirect(user, file!.mediaId!, "?download=1");
    expect(link.status).toBe(302);
    expect(await readSigned(link.location!)).toEqual(bytes);
  } finally {
    await fakeSandbox.rules.set([]);
    await eve.stop();
  }
}, 360_000);
