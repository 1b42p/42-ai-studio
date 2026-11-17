import { expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";

import { AppShell } from "@/components/studio/app-shell";
import { ChatFrame } from "@/components/studio/chat/chat-frame";
import { ChatView } from "@/components/studio/chat/chat-view";
import { navItemsFor } from "@/components/studio/nav";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { Trace } from "@/components/ui/trace";
import { copyConversation, copyStream } from "./fixtures/agent-copies";
import { expectNoHorizontalScroll, renderAtSize } from "./support/render";

const geometry = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopLeftRadius", "borderTopRightRadius",
  "borderBottomLeftRadius", "borderBottomRightRadius",
  "boxShadow",
] as const;

function expectStandardGeometry(actual: Element, reference: Element) {
  const actualStyle = getComputedStyle(actual);
  const referenceStyle = getComputedStyle(reference);
  for (const property of geometry) {
    expect(actualStyle[property], property).toBe(referenceStyle[property]);
  }
}

for (const theme of ["light", "dark"]) {
  for (const [viewport, size] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    test(`штатная геометрия чата: ${theme}, ${viewport}`, async () => {
      localStorage.setItem("theme", theme);
      const data = copyConversation({
        status: "working",
        message: "Подготовь раскадровку рекламного ролика кофейни: три сцены, двадцать секунд.",
        copy: copyStream({
          text: "Разделила историю на три сцены:\n\n1. **Утро в городе** — чашка кофе и первые лучи солнца.\n2. **Второй кофе в подарок** — две чашки встречаются в центре кадра.\n3. **Загляните до 11:00** — адрес и короткий призыв.",
          tool: {
            name: "bash",
            input: { command: "npx remotion still src/index.ts Main out/check/frame-180.png --frame=180" },
          },
          open: true,
        }),
      });
      const rendered = await renderAtSize(
        <>
          <AppShell navItems={navItemsFor(false)} pathname="/s">
            <ChatFrame>
              <ChatView
                title="Утренний кофе — ролик для кофейни"
                agent={{ data, events: [], status: "streaming" }}
                onCancel={vi.fn()}
                onRespond={vi.fn()}
                onSend={vi.fn()}
              />
            </ChatFrame>
          </AppShell>
          <div hidden data-testid="standard-reference">
            <Bubble variant="secondary"><BubbleContent>Образец</BubbleContent></Bubble>
            <InputGroup><InputGroupTextarea /></InputGroup>
            <Trace />
          </div>
        </>,
        size,
      );
      onTestFinished(async () => { await rendered.unmount(); });
      await expect.poll(() => document.documentElement.classList.contains(theme)).toBe(true);
      const reference = document.querySelector('[data-testid="standard-reference"]')!;
      for (const slot of ["bubble-content", "input-group", "trace"]) {
        expectStandardGeometry(
          document.querySelector(`[data-slot="${slot}"]`)!,
          reference.querySelector(`[data-slot="${slot}"]`)!,
        );
      }
      expectNoHorizontalScroll();
      await page.getByRole("button", { name: /Копия агента/ }).click();
      const dialog = page.getByRole("dialog");
      await expect.element(dialog.getByText("Утро в городе", { exact: false })).toBeVisible();
      await expect.poll(() => getComputedStyle(dialog.element()).opacity).toBe("1");
      await expect.poll(() => dialog.element().getBoundingClientRect().right).toBe(size.width);
      if (viewport === "desktop") {
        await expect.poll(() =>
          page.getByRole("textbox", { name: "Сообщение агенту" }).element().getBoundingClientRect().right
          <= dialog.element().getBoundingClientRect().left + 1,
        ).toBe(true);
      }
      expectNoHorizontalScroll();
      await page.screenshot({ path: `../../.vitest/attachments/chat-standard-${theme}-${viewport}.png` });
    });
  }
}
