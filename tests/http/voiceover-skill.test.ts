import { expect, test } from "vitest";

import { createSessionAs, sendAndWait } from "./support/chat";
import { createUser } from "./support/db";

test("агент загружает навык озвучки с запасным путём Piper", async () => {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const events = await sendAndWait(user, id, '/tool eve__skill {"name":"voiceover"}');
  const result = events.find((event) => event.type === "action.result" &&
    event.data.result.kind === "load-skill-result" && event.data.result.name === "voiceover");

  expect(result, "eve__skill должен вернуть навык voiceover").toBeDefined();
  if (result?.type !== "action.result") throw new Error("Нет результата загрузки навыка");
  expect(result.data.status).toBe("completed");
  expect(JSON.stringify(result.data.result)).toContain("Запасной путь");
  expect(JSON.stringify(result.data.result)).toContain("piper_speak.py");
});
