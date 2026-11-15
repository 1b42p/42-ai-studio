import { describe, expect, test } from "vitest";

import {
  customInstructionsLength,
  normalizeCustomInstructions,
  settingsPatchSchema,
} from "../../../lib/settings/schema";

describe("общие указания", () => {
  test("нормализует переводы строк, Unicode и удаляет скрытые управляющие символы", () => {
    expect(normalizeCustomInstructions(" \r\nПервое\rВторое\tе\u0308\u0000\u0007 \n "))
      .toBe("Первое\nВторое\tё");
  });

  test("сохраняет семейный эмодзи и соединители, удаляет форматирование и одиночные суррогаты", () => {
    expect(normalizeCustomInstructions(
      "👨‍👩‍👧\u200C\u200D\u200B\uFEFF\u2060\u00AD\u{E0041}\u2028\u2029\uD800x\uDC00",
    )).toBe("👨‍👩‍👧\u200C\u200Dx");
    expect(customInstructionsLength(" 👨‍👩‍👧 ")).toBe(5);
  });

  test("предел считает кодовые точки после нормализации", () => {
    expect(customInstructionsLength(` ${"😀".repeat(4000)}\r\n`)).toBe(4000);
    expect(settingsPatchSchema.safeParse({ customInstructions: "😀".repeat(4000) }).success).toBe(true);
    const result = settingsPatchSchema.safeParse({ customInstructions: "😀".repeat(4001) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "Общие указания не должны быть длиннее 4000 символов (сейчас 4001).",
      );
    }
    expect(customInstructionsLength("е\u0308".repeat(4000))).toBe(4000);
  });

  test.each([null, [], "", 2, {}, { unexpected: "текст" }, { customInstructions: 1 }])(
    "отвергает неверное тело %j",
    (body) => expect(settingsPatchSchema.safeParse(body).success).toBe(false),
  );

  test("очищает указания и возвращает нормализованное значение", () => {
    expect(settingsPatchSchema.parse({ customInstructions: " \r\n\u0000 " }))
      .toEqual({ customInstructions: "" });
    expect(settingsPatchSchema.parse({ customInstructions: "  Пиши\r\nкратко.  " }))
      .toEqual({ customInstructions: "Пиши\nкратко." });
  });
});
