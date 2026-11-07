import { Client } from "eve/client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  voiceoverFrameOutputs,
  voiceoverFrames,
} from "../../evals/voiceover/media-fixture";
import { loadConfig } from "../../lib/config";
import { fakeSandbox } from "./support/fake-sandbox";
import { startEveDev, type EveDevServer } from "./support/eve-dev";
import { createUser } from "./support/db";
import { loginAs } from "./support/auth";

let eve: EveDevServer;
let model: Server;
const requests: {
  messages: {
    content: string | { type: string; image_url?: { url: string } }[] | null;
  }[];
}[] = [];
beforeAll(async () => {
  model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "application/json");
    const first = requests.length === 1;
    response.end(
      JSON.stringify({
        id: `stub-media-${requests.length}`,
        object: "chat.completion",
        created: 1,
        model: "stub-media",
        choices: [
          {
            index: 0,
            finish_reason: first ? "tool_calls" : "stop",
            message: first
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "read-frame",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: '{"filePath":"out/frames/element-040.jpeg"}',
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "готово" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  eve = await startEveDev({
    NODE_ENV: "development",
    APP_STUB_EVAL_SANDBOX: "1",
    APP_TEST_MODE: "0",
    AGENT_MODEL: "stub-media",
    TELEGRAM_OIDC_ISSUER: "https://oauth.telegram.org",
    TAVILY_API_URL: "https://api.tavily.com",
    AGENT_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    AGENT_MODEL_API_KEY: "stub-key",
    AGENT_MODEL_CONTEXT_TOKENS: "1000000",
    AGENT_MODEL_STREAMING: "false",
    AGENT_REASONING: "none",
    EVE_DEV_STATE_DIR: `.tmp/eve-stub-eval-${process.pid}`,
  });
}, 240_000);
afterAll(async () => {
  await eve?.stop();
  await new Promise<void>((resolve, reject) =>
    model?.close((error) => (error ? reject(error) : resolve())),
  );
});

test("подмена read_file передаёт изображение модели без Daytona и настоящих команд", async () => {
  const client = new Client({
    host: eve.url,
    auth: { bearer: loadConfig().eveEvalAuthToken! },
    redirect: "manual",
  });
  const before = await fakeSandbox.counters();
  const { response } = await client.sessions.create({
    message: '/tool read_file {"filePath":"out/frames/element-040.jpeg"}',
    stubs: [
      {
        id: "recorded-frame",
        tool: "read_file",
        outcome: { response: voiceoverFrameOutputs[0] },
      },
    ],
  });
  const turn = await response.result();

  expect(turn.status).toBe("waiting");
  expect(
    turn.message === "готово",
    "локальный провайдер должен завершить ход после чтения кадра",
  ).toBe(true);
  expect(turn.events.some((event) => event.type === "turn.failed")).toBe(false);
  expect(
    turn.events.find((event) => event.type === "action.result")?.data,
  ).toMatchObject({
    status: "completed",
    result: { output: voiceoverFrameOutputs[0] },
  });
  expect(requests.length).toBeGreaterThanOrEqual(2);
  const images = requests
    .at(-1)!
    .messages.flatMap(({ content }) =>
      Array.isArray(content)
        ? content
            .filter((part) => part.type === "image_url")
            .map((part) => part.image_url?.url)
        : [],
    );
  expect(
    images.includes(`data:image/jpeg;base64,${voiceoverFrames[0].base64}`),
    "провайдер получил точные байты JPEG",
  ).toBe(true);
  expect(await fakeSandbox.counters()).toEqual(before);
});

test("пользовательский вход не открывает хранилище фикстур", async () => {
  const cookie = await loginAs(await createUser());
  const client = new Client({
    host: eve.url,
    headers: { cookie },
    redirect: "manual",
  });
  await expect(
    client.sessions.create({ message: "Не открывать хранилище фикстур" }),
  ).rejects.toMatchObject({
    status: 403,
    body: expect.stringMatching(/"code"\s*:\s*"eval_only"/u),
  });
});
