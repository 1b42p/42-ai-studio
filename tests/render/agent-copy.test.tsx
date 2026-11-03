/** Карточка копии агента и её боковая панель (#12). */
import type { ConversationState } from "eve/react";
import { expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";

import { copyConversation, copyStream, COPY_SESSION_ID } from "./fixtures/agent-copies";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

function view(state: ConversationState) {
  return (
    <div className="h-dvh">
      <ChatView
        agent={{ data: state, events: [], status: "ready" }}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>
  );
}

/** Рисует беседу и снимает её после теста: панель иначе остаётся в документе. */
async function renderAt(
  state: ConversationState,
  viewport: "desktop" | "phone" = "desktop",
): Promise<void> {
  const rendered =
    viewport === "phone"
      ? await renderOnPhone(view(state))
      : await renderOnDesktop(view(state));
  onTestFinished(async () => {
    await rendered.unmount();
  });
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
}

const LONG_OUTPUT =
  "Черновик собран: раскадровка на восемь сцен, кадры отрендерены в out/frames, музыка подобрана. " +
  "Осталось свести звук и проверить титры. Этот хвост в карточке не виден.";

test("до agent.started карточка показывает «Запускается…»", async () => {
  await renderAt(copyConversation({ started: false }));

  await expect.element(page.getByText("Копия агента")).toBeVisible();
  await expect.element(page.getByText("Запускается…")).toBeVisible();
});

for (const [name, scenario, expected] of [
  [
    "bash",
    copyStream({
      open: true,
      tool: { name: "bash", input: { command: "npm run render -- scene-1" } },
    }),
    "Сейчас: Команда: npm run render -- scene-1",
  ],
  [
    "edit_file",
    copyStream({ open: true, tool: { name: "edit_file", input: { filePath: "out/scene.py" } } }),
    "Сейчас: Правка scene.py",
  ],
  [
    "произвольного инструмента",
    copyStream({ open: true, tool: { name: "inspect_directory", label: "Проверяет папку" } }),
    "Сейчас: Проверяет папку",
  ],
  [
    "текста",
    copyStream({ text: "Готовлю раскадровку и подбираю музыку" }),
    "Сейчас: Готовлю раскадровку и подбираю музыку",
  ],
] as const) {
  test(`во время работы «Сейчас» показывает действие копии: ${name}`, async () => {
    await renderAt(copyConversation({ status: "working", copy: scenario }));

    await expect.element(page.getByText("Копия агента")).toBeVisible();
    await expect.element(page.getByText(expected)).toBeVisible();
    expect(document.body.textContent).not.toContain("inspect_directory");
    expect(document.body.innerText).not.toContain("{");
  });
}

test("копия, задавшая вопрос, показана как «Ждёт ответа»", async () => {
  await renderAt(
    copyConversation({
      status: "working",
      awaitingInput: true,
      copy: copyStream({ open: true, tool: { name: "bash", input: { command: "ls" } } }),
    }),
  );

  await expect.element(page.getByText("Ждёт ответа")).toBeVisible();
});

test("наблюдение без слежения не показывает «Сейчас»", async () => {
  await renderAt(
    copyConversation({
      status: "working",
      observation: "not-followed",
      copy: copyStream({ open: true, tool: { name: "bash", input: { command: "ls" } } }),
    }),
  );

  await expect.element(page.getByText("Работает")).toBeVisible();
  expect(document.body.textContent).not.toContain("Сейчас:");
});

test("завершённая копия свёрнута в строку с началом итога", async () => {
  await renderAt(copyConversation({ status: "completed", output: LONG_OUTPUT }));

  await expect.element(page.getByText("Копия завершила работу")).toBeVisible();
  await expect
    .element(page.getByText(/^Черновик собран: раскадровка на восемь сцен/))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("Этот хвост в карточке не виден.");
  expect(panel()).toBeNull();
});

test("ошибка копии видна на карточке и в панели", async () => {
  await renderAt(
    copyConversation({
      status: "failed",
      error: "Песочница недоступна: не настроен ключ Daytona.",
    }),
  );

  await expect.element(page.getByText("Копия завершилась ошибкой")).toBeVisible();
  await expect
    .element(page.getByText(/^Песочница недоступна: не настроен ключ Daytona\./))
    .toBeVisible();

  await page.getByRole("button", { name: /Копия завершилась ошибкой/ }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByText("Песочница недоступна: не настроен ключ Daytona."))
    .toBeVisible();
});

test("остановленная копия помечена «Копия остановлена»", async () => {
  await renderAt(copyConversation({ status: "cancelled" }));

  await expect.element(page.getByText("Копия остановлена")).toBeVisible();
});

test("нажатие на карточку открывает панель с ходом копии", async () => {
  await renderAt(
    copyConversation({
      status: "working",
      copy: copyStream({
        open: true,
        tool: { name: "bash", input: { command: "npm run render -- scene-1" } },
      }),
    }),
  );

  expect(panel()).toBeNull();
  await page.getByRole("button", { name: /Копия агента/ }).click();

  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText("Копия агента")).toBeVisible();
  await expect.element(dialog.getByText("Работает")).toBeVisible();
  await expect.element(dialog.getByText("Собери черновик ролика")).toBeVisible();
  await expect.element(dialog.getByText("$ npm run render -- scene-1")).toBeVisible();
});

test("Escape и кнопка закрывают панель и возвращают фокус", async () => {
  await renderAt(
    copyConversation({ status: "working", copy: copyStream({ text: "Пишу" }) }),
  );

  const trigger = page.getByRole("button", { name: /Копия агента/ });
  await trigger.click();
  await expect.element(page.getByRole("dialog")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

test("Enter в фокусе на карточке открывает панель", async () => {
  await renderAt(
    copyConversation({ status: "working", copy: copyStream({ text: "Пишу" }) }),
  );

  const trigger = page.getByRole("button", { name: /Копия агента/ });
  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");

  await expect.element(page.getByRole("dialog")).toBeVisible();
});

test("недоступный ход копии объяснён и показывает итог", async () => {
  await renderAt(
    copyConversation({
      status: "completed",
      observation: "unavailable",
      output: LONG_OUTPUT,
    }),
  );

  await page.getByRole("button", { name: /Копия завершила работу/ }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("Ход копии недоступен")).toBeVisible();
  await expect.element(dialog.getByText(LONG_OUTPUT)).toBeVisible();
});

test("без слежения за копией панель тоже говорит о недоступном ходе", async () => {
  await renderAt(
    copyConversation({ status: "working", observation: "not-followed", output: "Эхо: привет" }),
  );

  await page.getByRole("button", { name: /Копия агента/ }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("Ход копии недоступен")).toBeVisible();
  await expect.element(dialog.getByText("Работает")).toBeVisible();
});

test("в панели правка файла показана карточкой с diff", async () => {
  await renderAt(
    copyConversation({
      status: "working",
      copy: copyStream({
        result: {
          path: "/workspace/out/scene.py",
          created: false,
          replacements: 1,
          oldContent: "a\nb\nc\n",
          newContent: "a\nB\nc\n",
          linesAdded: 1,
          linesRemoved: 1,
        },
        tool: { name: "edit_file", input: { filePath: "out/scene.py", oldString: "b", newString: "B" } },
      }),
    }),
  );

  await expect.element(page.getByText("Сейчас: Правка scene.py")).toBeVisible();
  await page.getByRole("button", { name: /Копия агента/ }).click();

  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("scene.py", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("Изменён", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("+1 −1", { exact: true })).toBeVisible();
});

test("в панели ссылка на файл песочницы выведена текстом пути", async () => {
  await renderAt(
    copyConversation({
      status: "working",
      copy: copyStream({ text: "Кадр готов: [кадр](out/frame.png)" }),
    }),
  );

  await page.getByRole("button", { name: /Копия агента/ }).click();

  await expect.element(page.getByText("/workspace/out/frame.png")).toBeVisible();
  expect(document.querySelector('[data-slot="sheet-content"] a[href*="sandbox-file"]')).toBeNull();
});

test("на компьютере панель не шире 480 пикселей и не пересекает ленту", async () => {
  await renderAt(
    copyConversation({ status: "working", copy: copyStream({ text: "Пишу" }) }),
  );

  await page.getByRole("button", { name: /Копия агента/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  // Затемнения и блокировки основного чата на компьютере нет.
  expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();

  const content = panel()!;
  const thread = document.querySelector('[data-slot="message-scroller-viewport"]')!;

  // Панель выезжает, а лента освобождает место — ждём конца перехода.
  await vi.waitFor(
    () => {
      const rect = content.getBoundingClientRect();
      expect(rect.width).toBeLessThanOrEqual(480);
      expect(thread.getBoundingClientRect().right).toBeLessThanOrEqual(rect.left + 1);
    },
    { timeout: 3_000 },
  );

  expectNoHorizontalScroll();
});

test("на компьютере чат остаётся рабочим: клик в поле ввода не закрывает панель", async () => {
  await renderAt(
    copyConversation({ status: "working", copy: copyStream({ text: "Пишу" }) }),
  );

  await page.getByRole("button", { name: /Копия агента/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();

  await page.getByRole("textbox", { name: "Сообщение агенту" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Сообщение агенту" }))
    .toHaveFocus();
});

test("на телефоне карточка с длинным действием и итогом не даёт прокрутки", async () => {
  await renderAt(
    copyConversation({
      status: "working",
      copy: copyStream({
        open: true,
        tool: {
          name: "bash",
          input: { command: "npm run render -- " + "оченьдлинныйаргумент".repeat(12) },
        },
      }),
    }),
    "phone",
  );
  expectNoHorizontalScroll();

  await page.getByRole("button", { name: /Копия агента/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expectNoHorizontalScroll();
});

test("на телефоне панель занимает весь экран и закрывается", async () => {
  await renderAt(
    copyConversation({ status: "working", copy: copyStream({ text: "Пишу" }) }),
    "phone",
  );

  await page.getByRole("button", { name: /Копия агента/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();

  const rect = panel()!.getBoundingClientRect();
  expect(Math.round(rect.width)).toBe(window.innerWidth);
  expect(getComputedStyle(document.body).overflow).toBe("hidden");
  expectNoHorizontalScroll();

  await page.getByRole("button", { name: "Закрыть" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expectNoHorizontalScroll();
});

test("на странице нет сырого имени инструмента и JSON", async () => {
  await renderAt(
    copyConversation({ status: "working", copy: copyStream({ text: "Пишу сценарий" }) }),
  );
  await page.getByRole("button", { name: /Копия агента/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();

  const text = document.body.textContent ?? "";
  expect(text).not.toContain("eve:subagent:agent");
  expect(text).not.toContain(COPY_SESSION_ID);
  expect(document.body.innerText).not.toContain("{");
});
