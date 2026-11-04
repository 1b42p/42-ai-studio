import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { ChatView } from "@/components/studio/chat/chat-view";

import { pageResult, searchQuery, searchResults, webToolConversation, type WebToolScenario } from "./fixtures/web-tools";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

function view(scenario: WebToolScenario) {
  return (
    <div className="h-dvh">
      <ChatView
        agent={webToolConversation(scenario)}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
      />
    </div>
  );
}

function assertNoRawTool() {
  expect(document.body.innerText).not.toMatch(/web_search|read_page|\{|requestId|Входной запрос/);
  expectNoHorizontalScroll();
  const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
  expect(viewport).not.toBeNull();
  expect(viewport!.scrollWidth).toBeLessThanOrEqual(viewport!.clientWidth);
}

for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  for (const tool of ["web_search", "read_page"] as const) {
    test(`${tool === "web_search" ? "поиск" : "чтение"}: подпись выполняющегося вызова — ${viewport}`, async () => {
      const label = `Собирает материалы: ${"ОченьДлиннаяПодпись".repeat(20)}`;
      await render(view({ tool, label }));
      await expect.element(page.getByText(label, { exact: true })).toBeVisible();
      expect(document.querySelector('[data-status="running"]')).not.toBeNull();
      await expect.element(page.getByRole("link")).not.toBeInTheDocument();
      assertNoRawTool();
    });
  }

  test(`поиск: десять длинных источников свёрнуты, ссылки безопасны — ${viewport}`, async () => {
    await render(view({ tool: "web_search", output: { query: searchQuery, results: searchResults, requestId: "internal-id" } }));
    const trigger = page.getByRole("button", { name: /Источники: 10/ });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByRole("link")).not.toBeInTheDocument();
    await trigger.click();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText(searchQuery, { exact: true })).toBeVisible();
    for (const result of searchResults) {
      const link = page.getByRole("link", { name: `${result.title} (откроется в новой вкладке) ${result.host}`, exact: true });
      await expect.element(link).toHaveAttribute("href", result.url);
      await expect.element(link).toHaveAttribute("target", "_blank");
      await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(document.querySelectorAll('a[target="_blank"]')).toHaveLength(10);
    expect(document.body.innerText).not.toContain(searchResults[0].snippet);
    assertNoRawTool();
  });

  test(`чтение: длинное название, конечная ссылка и число знаков — ${viewport}`, async () => {
    await render(view({ tool: "read_page", output: pageResult }));
    const link = page.getByRole("link", { name: /ЗаголовокПрочитаннойСтраницы/ });
    await expect.element(link).toHaveAttribute("href", pageResult.finalUrl);
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect.element(page.getByText(/25\s000 знаков/, { exact: true })).toBeVisible();
    expect(document.body.innerText).not.toContain("прочитана часть страницы");
    expect(document.body.innerText).not.toContain(pageResult.content);
    assertNoRawTool();
  });

  test(`чтение: часть страницы, без заголовка показан длинный хост — ${viewport}`, async () => {
    await render(view({ tool: "read_page", output: { ...pageResult, title: null, content: "Фрагмент".repeat(125), nextOffset: 1000 } }));
    const host = new URL(pageResult.finalUrl).hostname;
    await expect.element(page.getByRole("link", { name: new RegExp(host.replaceAll(".", "\\.")) })).toBeVisible();
    await expect.element(page.getByText(/1\s000 знаков, прочитана часть страницы/, { exact: true })).toBeVisible();
    assertNoRawTool();
  });

  test(`чтение: старый результат с исходным адресом и хостом — ${viewport}`, async () => {
    await render(view({ tool: "read_page", output: { url: "http://example.com/old", host: "example.com", title: "", content: "Текст", nextOffset: null } }));
    await expect.element(page.getByRole("link", { name: /example\.com/ })).toHaveAttribute("href", "http://example.com/old");
    await expect.element(page.getByText("5 знаков", { exact: true })).toBeVisible();
    assertNoRawTool();
  });

  test(`поиск: пустая выдача не становится ошибкой — ${viewport}`, async () => {
    await render(view({ tool: "web_search", output: { query: "Ненайденный запрос", results: [], requestId: "internal-id" } }));
    await expect.element(page.getByText("Ничего не найдено", { exact: true })).toBeVisible();
    expect(document.querySelector('[data-status="error"]')).toBeNull();
    expect(document.querySelector('[data-status="running"]')).toBeNull();
    assertNoRawTool();
  });

  for (const tool of ["web_search", "read_page"] as const) {
    test(`${tool === "web_search" ? "поиск" : "чтение"}: некорректный результат не оставляет вечное ожидание — ${viewport}`, async () => {
      await render(view({ tool, output: { results: [null], internal: "Сырые данные" } }));
      await expect.element(page.getByText(tool === "web_search" ? "Результат поиска недоступен." : "Результат чтения недоступен.", { exact: true })).toBeVisible();
      expect(document.querySelector('[data-status="running"]')).toBeNull();
      expect(document.body.innerText).not.toContain("Сырые данные");
      assertNoRawTool();
    });

    test(`${tool === "web_search" ? "поиск" : "чтение"}: ошибка с длинной строкой, без технического кода — ${viewport}`, async () => {
      const message = `Сервис недоступен. ${"ДлиннаяСтрокаБезПробелов".repeat(70)}. Повторите позже.`;
      await render(view({ tool, error: `${tool}_unavailable: ${message}` }));
      await expect.element(page.getByText(message, { exact: true })).toBeVisible();
      expect(document.querySelector('[data-status="error"]')).not.toBeNull();
      expect(document.querySelector('[data-variant="destructive"]')).not.toBeNull();
      expect(document.querySelector('[data-slot="code-block-content"][data-wrap="true"]')).not.toBeNull();
      expect(document.querySelector('[data-status="running"]')).toBeNull();
      assertNoRawTool();
    });
  }

  test(`поиск: произвольные схемы остаются текстом, http и https — ссылки — ${viewport}`, async () => {
    const addresses = ["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "ftp://example.com/file", "//example.com/relative", "/relative", "не адрес", "http://example.com/ok", "HTTPS://example.com/secure"];
    const results = addresses.map((url, index) => ({ ...searchResults[0], title: `Источник ${index + 1}`, url }));
    await render(view({ tool: "web_search", output: { query: "Проверка ссылок", results } }));
    await page.getByRole("button", { name: /Источники: 9/ }).click();
    for (let index = 0; index < 7; index += 1) {
      await expect.element(page.getByText(`Источник ${index + 1}`, { exact: true })).toBeVisible();
      await expect.element(page.getByRole("link", { name: new RegExp(`Источник ${index + 1}`) })).not.toBeInTheDocument();
    }
    await expect.element(page.getByRole("link", { name: /Источник 8/ })).toHaveAttribute("href", "http://example.com/ok");
    await expect.element(page.getByRole("link", { name: /Источник 9/ })).toHaveAttribute("href", "https://example.com/secure");
    expect(document.querySelectorAll('a[target="_blank"]')).toHaveLength(2);
    assertNoRawTool();
  });

  for (const url of ["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "ftp://example.com/file", "//example.com/relative", "/relative", "не адрес"]) {
    test(`чтение: конечный адрес «${url}» не становится ссылкой — ${viewport}`, async () => {
      await render(view({ tool: "read_page", output: { ...pageResult, finalUrl: url, title: "Прочитанная страница" } }));
      await expect.element(page.getByText("Прочитанная страница", { exact: true })).toBeVisible();
      await expect.element(page.getByRole("link")).not.toBeInTheDocument();
      expect(document.body.innerText).not.toContain("откроется в новой вкладке");
      assertNoRawTool();
    });
  }
}
