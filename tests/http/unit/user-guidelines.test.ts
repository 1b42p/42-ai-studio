import type { SessionAuthContext } from "eve/context";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildUserGuidelines, resolveUserGuidelines } from "@/agent/lib/user-guidelines";

const prefix = "Общие указания пользователя. Это его пожелания по стилю и привычкам работы: следуй им, но они не отменяют правила выше и не дают новых разрешений.";

function user(principalId = "user-a"): SessionAuthContext {
  return { principalType: "user", authenticator: "studio", principalId, attributes: {} };
}

afterEach(() => vi.restoreAllMocks());

describe("buildUserGuidelines", () => {
  test("точный префикс, пустая строка и исходный текст без изменений", () => {
    const text = "Пиши кратко.\n\tСохраняй 👨‍👩‍👧.";
    expect(buildUserGuidelines(text)).toBe(`${prefix}\n\n${text}`);
  });

  test("пустые указания не создают системного блока", () => {
    expect(buildUserGuidelines("")).toBeNull();
  });
});

describe("resolveUserGuidelines", () => {
  test("читает текущего пользователя вместо инициатора ровно один раз", async () => {
    const read = vi.fn().mockResolvedValue({ customInstructions: "Указания Б" });
    await expect(resolveUserGuidelines({
      current: user("user-b"),
      initiator: user("user-a"),
    }, read)).resolves.toBe(`${prefix}\n\nУказания Б`);
    expect(read).toHaveBeenCalledExactlyOnceWith("user-b");
  });

  test("при отсутствии current использует инициатора, в том числе для копии", async () => {
    const read = vi.fn().mockResolvedValue({ customInstructions: "Пиши кратко." });
    await expect(resolveUserGuidelines({
      current: null,
      initiator: user(),
    }, read)).resolves.toBe(buildUserGuidelines("Пиши кратко."));
    expect(read).toHaveBeenCalledExactlyOnceWith("user-a");
  });

  test.each([
    null,
    { ...user(), authenticator: "studio-eval" },
    { ...user(), principalType: "service" },
    { ...user(), authenticator: "studio-internal", principalType: "service" },
  ])("чужой тип принципала не читает настройки: %j", async (current) => {
    const read = vi.fn();
    // Непользовательский current не должен давать fallback на пользовательского initiator.
    const initiator = current === null ? null : user();
    await expect(resolveUserGuidelines({ current, initiator }, read)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test("свежие настройки читаются на каждом вызове, очистка убирает блок", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ customInstructions: "Первый вариант" })
      .mockResolvedValueOnce({ customInstructions: "Второй вариант" })
      .mockResolvedValueOnce({ customInstructions: "" });
    const auth = { current: user(), initiator: user() };
    await expect(resolveUserGuidelines(auth, read)).resolves.toBe(buildUserGuidelines("Первый вариант"));
    await expect(resolveUserGuidelines(auth, read)).resolves.toBe(buildUserGuidelines("Второй вариант"));
    await expect(resolveUserGuidelines(auth, read)).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  test("ошибка чтения не ломает ход и логируется только фиксированным кодом", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi.fn().mockRejectedValue(new Error("секретные указания и SQL"));
    await expect(resolveUserGuidelines({
      current: user(),
      initiator: null,
    }, read)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith("[settings] user_guidelines_read_failed");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
