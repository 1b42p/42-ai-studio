import { conversationReducer, type EveDynamicToolPart } from "eve/react";
import { expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const spoken = "Слово ролика ".repeat(200).slice(0, 2000);
const longVoice = `ru-RU-${"СветланаОченьДлинноеИмя".repeat(8)}Neural`;

const call = {
  type: "dynamic-tool",
  toolName: "speak",
  toolCallId: "speak-1",
  input: { text: spoken, voice: longVoice },
} as const;

function view(part: EveDynamicToolPart) {
  return (
    <div className="h-dvh">
      <ChatView
        agent={{
          data: {
            ...conversationReducer.initial(),
            messages: [{ id: "assistant-1", role: "assistant", parts: [part] }],
          },
          events: [],
          status: "ready",
        }}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>
  );
}

for (const [viewport, render] of [
  ["телефон", renderOnPhone],
  ["компьютер", renderOnDesktop],
] as const) {
  test(`озвучка: выполняется — ${viewport}`, async () => {
    await render(view({ ...call, state: "input-available" }));
    await expect.element(page.getByText("Озвучка текста", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Воспроизвести" })).not.toBeInTheDocument();
    expect(document.body.innerText).not.toMatch(/\bspeak\b/);
    expect(document.body.innerText).not.toContain("{");
    expectNoHorizontalScroll();
  });

  test(`озвучка: готова, длинный текст и имя голоса — ${viewport}`, async () => {
    await commands.serveAudio();
    await render(
      view({
        ...call,
        state: "output-available",
        output: {
          audioPath: "/workspace/voice/scene.mp3",
          timingsPath: "/workspace/voice/scene.words.json",
          voice: longVoice,
          language: "ru-RU",
          format: "mp3",
          durationMs: 7000,
          wordCount: 120,
          text: spoken,
          media: { audioId: "11111111-1111-4111-8111-111111111111" },
        },
      }),
    );
    await expect.element(page.getByText("Озвучка готова", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/· русский · 0:07/)).toBeVisible();
    await expect.element(page.getByText(/русский/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Воспроизвести" })).toBeVisible();
    await expect.element(page.getByRole("slider", { name: "Перемотка" })).toBeVisible();
    const clamped = document.querySelector("[data-clamped='true']");
    expect(clamped).not.toBeNull();
    await page.getByRole("button", { name: "Показать полностью" }).click();
    expect(document.querySelector("[data-clamped='true']")).toBeNull();
    expect(document.body.innerText).toContain(spoken.slice(0, 40));
    expect(document.body.innerText).not.toMatch(/\bspeak\b/);
    expect(document.body.innerText).not.toContain("{");
    expectNoHorizontalScroll();
  });

  test(`озвучка: ошибка — ${viewport}`, async () => {
    await render(
      view({
        ...call,
        state: "output-error",
        errorText:
          "speak_rate_limited: Сервис озвучки ограничил частоту запросов (после трёх попыток). Подождите минуту и повторите.",
      }),
    );
    await expect.element(page.getByText("Озвучка", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(/Сервис озвучки ограничил частоту запросов/))
      .toBeVisible();
    expect(document.querySelector('[data-variant="destructive"]')).not.toBeNull();
    expect(document.body.innerText).not.toMatch(/\bspeak\b/);
    expect(document.body.innerText).not.toContain("{");
    expectNoHorizontalScroll();
  });

  test(`озвучка: файл недоступен — ${viewport}`, async () => {
    await render(
      view({
        ...call,
        state: "output-available",
        output: {
          text: "Короткая фраза",
          voice: "ru-RU-SvetlanaNeural",
          language: "ru-RU",
          durationMs: 1000,
          format: "mp3",
          wordCount: 2,
          media: {},
        },
      }),
    );
    await expect.element(page.getByText("Файл озвучки не найден", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Воспроизвести" })).not.toBeInTheDocument();
    expect(document.body.innerText).not.toMatch(/\bspeak\b/);
    expectNoHorizontalScroll();
  });
}
