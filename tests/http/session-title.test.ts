/**
 * Название сессии из текста первого сообщения: правила тикета #6.
 * Ожидаемые строки посчитаны вручную, не той же функцией.
 */
import { describe, expect, test } from "vitest";

import { sessionTitleFromText, titleFromEvents, titleSearchKey } from "../../lib/sessions/title";

const nineWords =
  "Слово слово слово слово слово слово слово слово слово…";

describe("sessionTitleFromText", () => {
  test.each([
    ["сделай ролик про пингвинов", "Сделай ролик про пингвинов"],
    ["  Нужен   промо-ролик\nдля кофейни ", "Нужен промо-ролик для кофейни"],
    ["https://example.com/very/long?x=1 сделай пересказ", "Example.com сделай пересказ"],
    ["https://example.com/a?x=1", "Example.com"],
    ["# Заголовок > цитата", "Заголовок > цитата"],
    ["```хвост", "Хвост"],
    ["конец```", "Конец```"],
    ["слово ".repeat(20).trim(), nineWords],
    ["а".repeat(100), `А${"а".repeat(58)}…`],
    ["б".repeat(100), `Б${"б".repeat(58)}…`],
    ["😀".repeat(70), `${"😀".repeat(59)}…`],
    ["😀".repeat(31), "😀".repeat(31)],
    ["а".repeat(25) + " " + "б".repeat(50), `А${"а".repeat(24)} ${"б".repeat(33)}…`],
    ["а".repeat(30) + " " + "б".repeat(40), `А${"а".repeat(29)}…`],
  ] as const)("«%s» → «%s»", (input, expected) => {
    expect(sessionTitleFromText(input)).toBe(expected);
    expect(Array.from(expected).length).toBeLessThanOrEqual(60);
  });

  test.each(["", "   ", "\n\n", "#"])("пустой результат для %j", (input) => {
    expect(sessionTitleFromText(input)).toBeNull();
  });
});

describe("titleSearchKey", () => {
  test.each([
    ["Ёжик", "ежик"],
    ["Отчёт", "отчет"],
    ["Example.COM", "example.com"],
    ["Сделай ролик про пингвинов", "сделай ролик про пингвинов"],
  ] as const)("%s → %s", (title, key) => {
    expect(titleSearchKey(title)).toBe(key);
  });
});

describe("titleFromEvents", () => {
  test("склеивает текстовые части без пробела", () => {
    expect(
      titleFromEvents([
        {
          type: "message.received",
          data: {
            message: "не это",
            parts: [
              { type: "text", text: "сделай " },
              { type: "text", text: "ролик" },
            ],
          },
        },
      ]),
    ).toBe("Сделай ролик");
  });

  test("без частей берёт data.message", () => {
    expect(
      titleFromEvents([{ type: "message.received", data: { message: "нужен ролик" } }]),
    ).toBe("Нужен ролик");
  });

  test("вложение без текста не даёт названия, берётся следующее сообщение", () => {
    expect(
      titleFromEvents([
        {
          type: "message.received",
          data: {
            message: "[file: a.png (image/png)]",
            parts: [{ type: "file", filename: "a.png", mediaType: "image/png" }],
          },
        },
        { type: "session.waiting", data: {} },
        { type: "message.received", data: { message: "теперь текст" } },
      ]),
    ).toBe("Теперь текст");
  });

  test("первое сообщение с текстом побеждает", () => {
    expect(
      titleFromEvents([
        { type: "message.received", data: { message: "первый" } },
        { type: "message.received", data: { message: "второй" } },
      ]),
    ).toBe("Первый");
  });

  test("сообщение из одних решёток пропускается", () => {
    expect(
      titleFromEvents([
        { type: "message.received", data: { parts: [{ type: "text", text: "#" }] } },
        { type: "message.received", data: { message: "дальше" } },
      ]),
    ).toBe("Дальше");
  });

  test("пусто, если текста нет", () => {
    expect(
      titleFromEvents([
        { type: "message.received", data: { message: "  ", parts: [] } },
        { type: "turn.completed", data: {} },
      ]),
    ).toBeNull();
  });
});
