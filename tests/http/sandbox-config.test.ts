import { expect, test } from "vitest";
import { startApp } from "./support/app";

test.each([undefined, "", "invalid-base64", Buffer.alloc(31).toString("base64")])(
  "сервер не запускается с некорректным SECRETS_ENCRYPTION_KEY (%s)",
  async (value) => {
    const app = await startApp({ env: { SECRETS_ENCRYPTION_KEY: value }, expectExit: true });
    try {
      expect(await app.exited).not.toBe(0);
      expect(app.output()).toContain("SECRETS_ENCRYPTION_KEY");
    } finally {
      await app.stop();
    }
  },
);

test.each([
  ["SANDBOX_ARCHIVE_AFTER_DAYS", "31"],
  ["SANDBOX_IDLE_STOP_MINUTES", "0"],
  ["SANDBOX_QUEUE_POLL_MS", "50"],
])("сервер отвергает %s=%s с названием переменной", async (name, value) => {
  const app = await startApp({ env: { [name]: value }, expectExit: true });
  try {
    expect(await app.exited).not.toBe(0);
    expect(app.output()).toContain(name);
  } finally {
    await app.stop();
  }
});
