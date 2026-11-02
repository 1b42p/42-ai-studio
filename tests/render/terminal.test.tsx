import { conversationReducer, type EveDynamicToolPart } from "eve/react";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const call = {
  type: "dynamic-tool",
  toolName: "bash",
  toolCallId: "terminal-1",
  input: { command: "npm run build" },
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

for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`терминал: выполняющаяся команда без пустой кнопки раскрытия — ${viewport}`, async () => {
    await render(view({ ...call, state: "input-available" }));
    await expect.element(page.getByText("$ npm run build", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Выполняется…", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /npm run build/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("bash");
    expect(document.body.innerText).not.toContain("{");
    expectNoHorizontalScroll();
  });

  test(`терминал: ввод команды ещё пишется, длинный заголовок усечён — ${viewport}`, async () => {
    const command = "printf " + "оченьдлинныйаргумент".repeat(80);
    await render(view({ ...call, input: { command }, inputText: '{"command":"printf ', state: "input-streaming" }));
    const title = page.getByText(`$ ${command}`, { exact: true });
    await expect.element(title).toBeVisible();
    await expect.element(page.getByText("Выполняется…", { exact: true })).toBeVisible();
    expect(getComputedStyle(title.element()).textOverflow).toBe("ellipsis");
    expectNoHorizontalScroll();
  });

  test(`терминал: код 0, ANSI убран, stderr — обычные сообщения, весь вывод копируется — ${viewport}`, async () => {
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const stdout = "сборка готова\n" + "длиннаястрока".repeat(100);
    await render(view({
      ...call,
      state: "output-available",
      output: { status: "completed", exitCode: 0, stdout: `\u001b[32m${stdout}\u001b[0m`, stderr: "предупреждение", truncated: true },
    }));
    await expect.element(page.getByRole("button", { name: /npm run build/ })).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText("Код 0", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Вывод обрезан", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Сообщения", { exact: true })).toBeVisible();
    await expect.element(page.getByText("предупреждение", { exact: true })).toBeVisible();
    expect(document.querySelector('[data-variant="destructive"]')).toBeNull();
    expect(document.body.textContent).not.toContain("\u001b");
    expect(document.body.textContent).not.toContain("bash");
    expect(document.body.innerText).not.toContain("{");
    await page.getByRole("button", { name: "Копировать" }).first().click();
    expect(clipboard).toHaveBeenCalledWith(stdout);
    expectNoHorizontalScroll();
    clipboard.mockRestore();
  });

  test(`терминал: ненулевой код отмечает ошибкой только stderr — ${viewport}`, async () => {
    await render(view({
      ...call,
      state: "output-available",
      output: { status: "completed", exitCode: 2, stdout: "начало сборки", stderr: "\u001b[31mНе удалось собрать ролик\u001b[0m", truncated: false },
    }));
    await expect.element(page.getByText("Код 2", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Ошибки", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Не удалось собрать ролик", { exact: true })).toBeVisible();
    const output = page.getByText("начало сборки", { exact: true }).element();
    const error = page.getByText("Не удалось собрать ролик", { exact: true }).element();
    expect(getComputedStyle(output).color).not.toBe(getComputedStyle(error).color);
    expectNoHorizontalScroll();
  });

  test(`терминал: фоновая команда показывает текущий вывод — ${viewport}`, async () => {
    await render(view({
      ...call,
      state: "output-available",
      output: { status: "running", pid: 42, outputDirectory: "/tmp/.eve/jobs/test", message: "Command is running", stdout: "кадр 1 готов", stderr: "", truncated: false },
    }));
    await expect.element(page.getByText("Выполняется в фоне", { exact: true })).toBeVisible();
    await expect.element(page.getByText("кадр 1 готов", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("/tmp/.eve");
    expect(document.body.textContent).not.toContain("Command is running");
    expectNoHorizontalScroll();
  });

  test(`терминал: ошибка инструмента показана русским текстом — ${viewport}`, async () => {
    await render(view({ ...call, state: "output-error", errorText: "\u001b[31mПесочница недоступна: не настроен ключ Daytona.\u001b[0m" }));
    await expect.element(page.getByText("Ошибка выполнения", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Песочница недоступна: не настроен ключ Daytona.", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("\u001b");
    expectNoHorizontalScroll();
  });

  test(`терминал: более 12 строк свёрнуты, раскрываются и прокручиваются внутри карточки — ${viewport}`, async () => {
    const stdout = Array.from({ length: 40 }, (_, index) => `строка ${index + 1}`).join("\n");
    await render(view({ ...call, state: "output-available", output: { status: "completed", exitCode: 0, stdout, stderr: "", truncated: false } }));
    const trigger = page.getByRole("button", { name: /npm run build/ });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByText(stdout, { exact: true })).not.toBeInTheDocument();
    await trigger.click();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText(stdout, { exact: true })).toBeVisible();
    const code = page.getByText(stdout, { exact: true }).element();
    const scroller = code.parentElement!;
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(scroller.clientHeight).toBeLessThanOrEqual(256);
    expectNoHorizontalScroll();
  });

  test(`терминал: ровно 12 строк раскрыты, завершающий перенос не добавляет строку — ${viewport}`, async () => {
    const stdout = Array.from({ length: 12 }, (_, index) => `строка ${index + 1}`).join("\n") + "\n";
    await render(view({ ...call, state: "output-available", output: { status: "completed", exitCode: 0, stdout, stderr: "", truncated: false } }));
    await expect.element(page.getByRole("button", { name: /npm run build/ })).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText(stdout, { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
  });
}
