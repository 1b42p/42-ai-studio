/** Инструменты speak и list_voices на тестовом Edge TTS. */
import { eq } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { beforeEach, describe, expect, test } from "vitest";

import { media, toolCallMedia } from "../../lib/db/schema";
import { createSessionAs, eveClientAs, readStreamUntil, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { edgeTtsStub } from "./support/edge-tts";
import { SAMPLE_MP3 } from "./support/edge-tts-server";
import { fakeSandbox } from "./support/fake-sandbox";
import { mediaRedirect, readSigned } from "./support/media";
import { s3 } from "./support/s3";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
  await edgeTtsStub.reset();
  await createDaytonaKey();
});

function toolCommand(name: string, input: Record<string, unknown>): string {
  return `/tool ${name} ${JSON.stringify(input)}`;
}

/** `readFile` отдаёт `Buffer`, S3 — `Uint8Array`: сравниваем байты, не класс. */
function expectBytes(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual).not.toBeNull();
  expect(Buffer.from(actual!)).toEqual(Buffer.from(expected));
}

function toolResult(events: readonly MessageStreamEvent[], name: string) {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find(
    (item) => item.data.result.kind === "tool-result" && item.data.result.toolName === name,
  );
  expect(event, `Нет результата ${name}`).toBeDefined();
  return event!.data;
}

function completedOutput(events: readonly MessageStreamEvent[], name: string): Record<string, unknown> {
  const result = toolResult(events, name);
  expect(result.status).toBe("completed");
  expect(result.result.kind).toBe("tool-result");
  return result.result.kind === "tool-result" ? (result.result.output as Record<string, unknown>) : {};
}

describe("speak", () => {
  test("пишет mp3 и тайминги и публикует аудио владельцу", async () => {
    const user = await createUser();
    const other = await createUser();
    const { id } = await createSessionAs(user);
    const events = await sendAndWait(
      user,
      id,
      toolCommand("speak", { text: "Привет, мир. Как дела?", outputPath: "voice/hello" }),
    );
    const output = completedOutput(events, "speak");
    expect(output.audioPath).toBe("/workspace/voice/hello.mp3");
    expect(output.timingsPath).toBe("/workspace/voice/hello.words.json");
    expect(output.durationMs).toBe(1000);
    expect(output.format).toBe("mp3");
    expect(output.voice).toBe("ru-RU-SvetlanaNeural");
    expect(output.wordCount).toBe(4);

    const audio = await fakeSandbox.files.read(id, "/workspace/voice/hello.mp3");
    expectBytes(audio, SAMPLE_MP3);
    const timings = JSON.parse(
      new TextDecoder().decode((await fakeSandbox.files.read(id, "/workspace/voice/hello.words.json"))!),
    ) as { words: { text: string }[]; durationMs: number; version: number };
    expect(timings.version).toBe(1);
    expect(timings.durationMs).toBe(1000);
    expect(timings.words.map((word) => word.text)).toEqual(["Привет,", "мир.", "Как", "дела?"]);

    const prefix = `u/${user.id}/s/${id}/tool-media/`;
    const keys = await s3().listKeys(prefix);
    expect(keys.length).toBe(1);
    expectBytes(await s3().getBytes(keys[0]!), SAMPLE_MP3);

    const rows = await db().select().from(media).where(eq(media.appSessionId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool_media");
    const links = await db().select().from(toolCallMedia).where(eq(toolCallMedia.appSessionId, id));
    expect(links).toHaveLength(1);
    expect(links[0]?.mediaId).toBe(rows[0]?.id);
    expect(links[0]?.sandboxPath).toBe("/workspace/voice/hello.mp3");
    const result = toolResult(events, "speak");
    expect(result.result.kind === "tool-result" ? result.result.callId : "").toBe(links[0]?.callId);

    const audioId = (output.media as { audioId: string }).audioId;
    const redirect = await mediaRedirect(user, audioId);
    expect(redirect.status).toBe(302);
    expect(redirect.location).not.toBeNull();
    expectBytes(await readSigned(redirect.location!), SAMPLE_MP3);
    expect((await mediaRedirect(other, audioId)).status).toBe(404);
  });

  test("другой вызов с тем же путём создаёт новую строку, старая не меняется", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await sendAndWait(user, id, toolCommand("speak", { text: "Привет, мир.", outputPath: "voice/hello" }));
    const first = await db().select().from(toolCallMedia).where(eq(toolCallMedia.appSessionId, id));
    expect(first).toHaveLength(1);

    await sendAndWait(user, id, toolCommand("speak", { text: "Ещё одна фраза.", outputPath: "voice/hello" }));
    const links = await db().select().from(toolCallMedia).where(eq(toolCallMedia.appSessionId, id));
    expect(links).toHaveLength(2);
    const kept = links.find((link) => link.id === first[0]?.id);
    expect(kept).toMatchObject({
      callId: first[0]?.callId,
      mediaId: first[0]?.mediaId,
      sandboxPath: first[0]?.sandboxPath,
    });
  }, 45_000);

  test("два отказа 429, затем нормальный ответ — три рукопожатия", async () => {
    await edgeTtsStub.setMode("rate_limit", 2);
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const output = completedOutput(
      await sendAndWait(user, id, toolCommand("speak", { text: "Привет, мир.", outputPath: "voice/retry" })),
      "speak",
    );
    expect(output.audioPath).toBe("/workspace/voice/retry.mp3");
    expect((await edgeTtsStub.calls()).handshakes).toBe(3);
  });

  test("постоянный 429 — speak_rate_limited и ровно три попытки", async () => {
    await edgeTtsStub.setMode("rate_limit");
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const result = toolResult(
      await sendAndWait(user, id, toolCommand("speak", { text: "Привет, мир.", outputPath: "voice/limited" })),
      "speak",
    );
    expect(result.status).toBe("failed");
    const message = result.error?.message ?? "";
    expect(message).toContain("speak_rate_limited");
    expect(message).not.toMatch(/https?:|wss?:|HANDSHAKE|ECONNREFUSED|127\.0\.0\.1/);
    expect((await edgeTtsStub.calls()).handshakes).toBe(3);
    expect(await fakeSandbox.files.read(id, "/workspace/voice/limited.mp3")).toBeNull();
  }, 20_000);

  test("без границ слов файлы не появляются", async () => {
    await edgeTtsStub.setMode("no_boundaries");
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const result = toolResult(
      await sendAndWait(user, id, toolCommand("speak", { text: "Привет, мир.", outputPath: "voice/empty" })),
      "speak",
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message ?? "").toContain("speak_text_not_readable");
    expect(await fakeSandbox.files.read(id, "/workspace/voice/empty.mp3")).toBeNull();
    expect(await s3().listKeys(`u/${user.id}/s/${id}/tool-media/`)).toEqual([]);
  });

  test("путь вне рабочей области и неизвестный голос", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const outside = toolResult(
      await sendAndWait(user, id, toolCommand("speak", { text: "Привет", outputPath: "../../etc/x" })),
      "speak",
    );
    expect(outside.status).toBe("failed");
    expect(outside.error?.message ?? "").toContain("speak_bad_path");
    expect((await edgeTtsStub.calls()).handshakes).toBe(0);

    const absolute = toolResult(
      await sendAndWait(user, id, toolCommand("speak", { text: "Привет", outputPath: "/etc/passwd" })),
      "speak",
    );
    expect(absolute.error?.message ?? "").toContain("speak_bad_path");
    expect(await fakeSandbox.files.read(id, "/etc/passwd")).toBeNull();

    await edgeTtsStub.setMode("close_1007");
    const missing = toolResult(
      await sendAndWait(
        user,
        id,
        toolCommand("speak", { text: "Привет", voice: "xx-XX-NobodyNeural", outputPath: "voice/nobody" }),
      ),
      "speak",
    );
    expect(missing.status).toBe("failed");
    expect(missing.error?.message ?? "").toContain("speak_voice_not_found");
    expect(missing.error?.message ?? "").toContain("xx-XX-NobodyNeural");
    expect(await fakeSandbox.files.read(id, "/workspace/voice/nobody.mp3")).toBeNull();
  });

  test("пробелы — speak_bad_input, сервис не вызывается", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const result = toolResult(
      await sendAndWait(user, id, toolCommand("speak", { text: "   ", outputPath: "voice/blank" })),
      "speak",
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message ?? "").toContain("speak_bad_input");
    expect((await edgeTtsStub.calls()).handshakes).toBe(0);
  });
});

describe("list_voices", () => {
  test("русский, неизвестный язык и мужской голос", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const russian = completedOutput(
      await sendAndWait(user, id, toolCommand("list_voices", { language: "ru" })),
      "list_voices",
    );
    const voices = russian.voices as { name: string; locale: string; gender: string; displayName: string; multilingual: boolean }[];
    expect(voices).toHaveLength(2);
    expect(voices.map((voice) => voice.name).sort()).toEqual([
      "ru-RU-DmitryNeural",
      "ru-RU-SvetlanaNeural",
    ]);
    expect(voices.every((voice) => voice.locale === "ru-RU" && voice.displayName.length > 0)).toBe(true);

    const unknown = completedOutput(
      await sendAndWait(user, id, toolCommand("list_voices", { language: "xx" })),
      "list_voices",
    );
    expect(unknown.voices).toEqual([]);
    expect(unknown.availableLocales).toEqual(["en-US", "ru-RU"]);

    const male = completedOutput(
      await sendAndWait(user, id, toolCommand("list_voices", { language: "ru", gender: "Male" })),
      "list_voices",
    );
    expect(male.voices).toEqual([
      {
        name: "ru-RU-DmitryNeural",
        locale: "ru-RU",
        gender: "Male",
        displayName: "Dmitry",
        multilingual: false,
      },
    ]);
  });
});

describe("подмена инструментов", () => {
  test("stubs доходят до потока и не обращаются к Edge TTS", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);
    const created = await client.sessions.create({
      message: '/tool speak {"text":"Привет"}',
      stubs: [
        {
          id: "speak-stub",
          tool: "speak",
          outcome: { response: { audioPath: "/workspace/stub.mp3", wordCount: 1 } },
        },
        {
          id: "voices-stub",
          tool: "list_voices",
          outcome: { response: { voices: [{ name: "stub" }] } },
        },
      ],
    });
    const speakEvents = await readStreamUntil(created.response, "session.waiting");
    const speak = toolResult(speakEvents, "speak");
    expect(speak.status).toBe("completed");
    expect(speak.result.kind === "tool-result" ? speak.result.output : null).toMatchObject({
      audioPath: "/workspace/stub.mp3",
    });

    const voicesResponse = await created.session.send('/tool list_voices {"language":"ru"}');
    const voiceEvents = await readStreamUntil(voicesResponse, "session.waiting");
    const voices = toolResult(voiceEvents, "list_voices");
    expect(voices.status).toBe("completed");
    expect((await edgeTtsStub.calls()).handshakes).toBe(0);
    expect((await edgeTtsStub.calls()).voiceRequests).toBe(0);
    expect((await edgeTtsStub.calls()).requests).toEqual([]);
  });
});
