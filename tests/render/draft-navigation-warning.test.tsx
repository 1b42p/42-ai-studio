import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { useUnsavedChangesWarning } from "@/components/studio/use-text-draft";
import { renderOnDesktop } from "./support/render";

function Guard() {
  useUnsavedChangesWarning(true);
  return <a href="/settings">Уйти</a>;
}

function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test("отмена ссылки не разрешает уход, согласие снимает ровно одно beforeunload предупреждение", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await renderOnDesktop(<Guard />);
  const link = page.getByRole("link", { name: "Уйти" }).element();
  const nativeUnload: boolean[] = [];
  link.addEventListener("click", (event) => {
    event.preventDefault(); // Do not navigate the render-test runner.
    nativeUnload.push(unload()); // Simulate the link's native default activation.
  });
  const click = () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  click();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(nativeUnload).toEqual([]);
  expect(unload()).toBe(true);
  click();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(nativeUnload).toEqual([false]);
  expect(unload()).toBe(true); // A subsequent reload/close is protected again.
});

test("согласие на ссылку без выгрузки не разрешает последующее закрытие вкладки", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await renderOnDesktop(<Guard />);
  vi.useFakeTimers();
  const link = page.getByRole("link", { name: "Уйти" }).element();
  link.addEventListener("click", (event) => event.preventDefault());
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  expect(confirm).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(0);
  expect(unload()).toBe(true);
});
