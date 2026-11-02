import { conversationReducer, type EveDynamicToolPart } from "eve/react";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";
import { DIFF_PREVIEW_LINES } from "@/lib/edit-file/diff-view";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const base = {
  type: "dynamic-tool",
  toolName: "edit_file",
  toolCallId: "edit-1",
  input: { filePath: "/workspace/src/notes.txt", oldString: "two", newString: "zwei" },
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

function assertNoRawTool() {
  expect(document.body.textContent).not.toContain("edit_file");
  expect(document.body.innerText).not.toContain("{");
}

for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`правка: вызов в процессе — ${viewport}`, async () => {
    await render(view({ ...base, state: "input-available" }));
    await expect.element(page.getByText("notes.txt", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Правка…", { exact: true })).toBeVisible();
    assertNoRawTool();
    expectNoHorizontalScroll();
  });

  test(`правка: изменение с контекстом и пропуском — ${viewport}`, async () => {
    const oldContent = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";
    const newContent = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "J", "k"].join("\n") + "\n";
    await render(view({
      ...base,
      state: "output-available",
      output: {
        path: "/workspace/src/notes.txt",
        created: false,
        replacements: 2,
        oldContent,
        newContent,
        linesAdded: 2,
        linesRemoved: 2,
      },
    }));
    await expect.element(page.getByText("notes.txt", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Изменён", { exact: true })).toBeVisible();
    await expect.element(page.getByText("+2 −2", { exact: true })).toBeVisible();
    await expect.element(page.getByText("B", { exact: true })).toBeVisible();
    await expect.element(page.getByText("J", { exact: true })).toBeVisible();
    expect(document.body.textContent).toMatch(/⋯ \d+ строк без изменений/);
    expect(document.body.textContent).toContain("+");
    expect(document.body.textContent).toContain("−");
    assertNoRawTool();
    expectNoHorizontalScroll();
  });

  test(`правка: создание файла — ${viewport}`, async () => {
    await render(view({
      ...base,
      input: { filePath: "/workspace/new.txt", newString: "hello\n" },
      state: "output-available",
      output: {
        path: "/workspace/new.txt",
        created: true,
        replacements: 0,
        oldContent: null,
        newContent: "hello\n",
        linesAdded: 1,
        linesRemoved: 0,
      },
    }));
    await expect.element(page.getByText("new.txt", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Создан", { exact: true })).toBeVisible();
    await expect.element(page.getByText("hello", { exact: true })).toBeVisible();
    assertNoRawTool();
    expectNoHorizontalScroll();
  });

  test(`правка: replaceAll — ${viewport}`, async () => {
    await render(view({
      ...base,
      input: { filePath: "/workspace/a.txt", oldString: "x", newString: "y", replaceAll: true },
      state: "output-available",
      output: {
        path: "/workspace/a.txt",
        created: false,
        replacements: 3,
        oldContent: "x x x",
        newContent: "y y y",
        linesAdded: 1,
        linesRemoved: 1,
      },
    }));
    await expect.element(page.getByText("y y y", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Изменён", { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
  });

  test(`правка: ошибка без diff — ${viewport}`, async () => {
    await render(view({
      ...base,
      state: "output-error",
      errorText: "Фрагмент не найден в /workspace/src/notes.txt. Сравнение точное: проверь пробелы, отступы и переводы строк.",
    }));
    await expect.element(page.getByText("Ошибка", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Фрагмент не найден/)).toBeVisible();
    expect(document.body.textContent).not.toContain("⋯");
    assertNoRawTool();
    expectNoHorizontalScroll();
  });

  test(`правка: diff длиннее ${DIFF_PREVIEW_LINES} строк свёрнут — ${viewport}`, async () => {
    // 120 удалённых + 120 добавленных строк > порога превью.
    const manyOld = Array.from({ length: 120 }, (_, index) => `line-${index}-a`).join("\n") + "\n";
    const manyNew = Array.from({ length: 120 }, (_, index) => `line-${index}-b`).join("\n") + "\n";
    await render(view({
      ...base,
      state: "output-available",
      output: {
        path: "/workspace/long.txt",
        created: false,
        replacements: 120,
        oldContent: manyOld,
        newContent: manyNew,
        linesAdded: 120,
        linesRemoved: 120,
      },
    }));
    const showAll = page.getByRole("button", { name: /Показать все \d+ строк/ });
    await expect.element(showAll).toBeVisible();
    await showAll.click();
    await expect.element(page.getByRole("button", { name: "Свернуть" })).toBeVisible();
    expectNoHorizontalScroll();
  });

  test(`правка: файл больше 4000 строк — только заголовок — ${viewport}`, async () => {
    const content = `${"x\n".repeat(4001)}`;
    await render(view({
      ...base,
      state: "output-available",
      output: {
        path: "/workspace/huge.txt",
        created: false,
        replacements: 1,
        oldContent: content,
        newContent: content.replace("x", "y"),
        linesAdded: 1,
        linesRemoved: 1,
      },
    }));
    await expect.element(page.getByText("huge.txt", { exact: true })).toBeVisible();
    await expect.element(page.getByText("+1 −1", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Изменение слишком большое для показа", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("⋯");
    expectNoHorizontalScroll();
  });
}
