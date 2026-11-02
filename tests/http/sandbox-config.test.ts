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
