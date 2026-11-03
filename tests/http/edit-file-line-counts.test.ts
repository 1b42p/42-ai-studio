/**
 * Точечные тесты чистых функций правки файла: приложение не нужно.
 */
import { describe, expect, test } from "vitest";

import {
  applyEditFile,
  countOccurrences,
  formatEditFileModelOutput,
} from "../../lib/edit-file/apply";
import { EditFileError, editFileErrorMessage } from "../../lib/edit-file/errors";
import { assertEditFilePath } from "../../lib/edit-file/path";
import { contentLineCount, countLineChanges } from "../../lib/edit-file/line-counts";
import { buildDiffRows, isDiffTooLarge } from "../../lib/edit-file/diff-view";

describe("countLineChanges", () => {
  test.each([
    ["a", "a\n", 1, 1],
    ["a\n", "a\nb\n", 1, 0],
    ["", "x\n", 1, 0],
    ["x\n", "", 0, 1],
    ["a\nb\n", "a\nc\n", 1, 1],
  ] as const)("%j → %j даёт +%i −%i", (oldContent, newContent, added, removed) => {
    expect(countLineChanges(oldContent, newContent)).toEqual({
      linesAdded: added,
      linesRemoved: removed,
    });
  });
});

describe("contentLineCount", () => {
  test("пустой текст — 0 строк", () => {
    expect(contentLineCount("")).toBe(0);
  });

  test("четыре тысячи одна строка превышает порог показа", () => {
    const text = `${"x\n".repeat(4001)}`;
    expect(contentLineCount(text)).toBe(4001);
    expect(isDiffTooLarge(text, text)).toBe(true);
    expect(isDiffTooLarge("a\n".repeat(4000), "a\n".repeat(4000))).toBe(false);
  });
});

describe("formatEditFileModelOutput", () => {
  test("не содержит содержимого файла", () => {
    const text = formatEditFileModelOutput({
      path: "/workspace/secret.txt",
      created: false,
      replacements: 2,
      linesAdded: 1,
      linesRemoved: 1,
    });
    expect(text).toBe(
      "Файл /workspace/secret.txt изменён: замен 2, добавлено 1 и удалено 1 строк.",
    );
    expect(text).not.toContain("oldContent");
    expect(text).not.toContain("{");
  });

  test("создание использует глагол «создан»", () => {
    expect(
      formatEditFileModelOutput({
        path: "/workspace/a.ts",
        created: true,
        replacements: 0,
        linesAdded: 3,
        linesRemoved: 0,
      }),
    ).toContain("создан");
  });
});

describe("applyEditFile", () => {
  test("замена единственного фрагмента", () => {
    const result = applyEditFile("/workspace/a.txt", "one\ntwo\nthree\n", {
      oldString: "two",
      newString: "zwei",
    });
    expect(result).toMatchObject({
      created: false,
      replacements: 1,
      oldContent: "one\ntwo\nthree\n",
      newContent: "one\nzwei\nthree\n",
      linesAdded: 1,
      linesRemoved: 1,
    });
  });

  test("replaceAll заменяет все вхождения", () => {
    const result = applyEditFile("/workspace/a.txt", "x x x", {
      oldString: "x",
      newString: "y",
      replaceAll: true,
    });
    expect(result.replacements).toBe(3);
    expect(result.newContent).toBe("y y y");
  });

  test("создание нового файла", () => {
    const result = applyEditFile("/workspace/new.txt", null, { newString: "hello\n" });
    expect(result).toMatchObject({
      created: true,
      oldContent: null,
      newContent: "hello\n",
      replacements: 0,
    });
  });

  test("overwrite перезаписывает непустой файл", () => {
    const result = applyEditFile("/workspace/a.txt", "old\n", {
      newString: "new\n",
      overwrite: true,
    });
    expect(result.oldContent).toBe("old\n");
    expect(result.newContent).toBe("new\n");
    expect(result.created).toBe(false);
  });

  test("пустой newString без oldString создаёт пустой файл", () => {
    expect(applyEditFile("/workspace/empty.txt", null, { newString: "" })).toMatchObject({
      created: true,
      oldContent: null,
      newContent: "",
    });
  });

  test("оба пустых oldString и newString — no_change", () => {
    expect(() => applyEditFile("/workspace/a.txt", null, { oldString: "", newString: "" })).toThrow(
      editFileErrorMessage("no_change"),
    );
  });

  test.each([
    ["not_found", null, { oldString: "x", newString: "y" }, "/workspace/missing.txt"],
    ["exists", "data", { newString: "other" }, "/workspace/a.txt"],
    ["no_change", "a", { oldString: "a", newString: "a" }, "/workspace/a.txt"],
    ["fragment_not_found", "hello", { oldString: "x", newString: "y" }, "/workspace/a.txt"],
  ] as const)("%s", (code, existing, input, path) => {
    expect(() => applyEditFile(path, existing, input)).toThrow(EditFileError);
    try {
      applyEditFile(path, existing, input);
    } catch (error) {
      expect(error).toMatchObject({ code, message: editFileErrorMessage(code, path) });
    }
  });

  test("ambiguous указывает число вхождений", () => {
    try {
      applyEditFile("/workspace/a.txt", "aa", { oldString: "a", newString: "b" });
      throw new Error("ожидалась ошибка");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ambiguous",
        message: editFileErrorMessage("ambiguous", "/workspace/a.txt", 2),
      });
    }
  });
});

describe("assertEditFilePath", () => {
  test("пустой и $HOME — bad_path", () => {
    expect(() => assertEditFilePath("")).toThrow(editFileErrorMessage("bad_path"));
    expect(() => assertEditFilePath("$HOME/x")).toThrow(editFileErrorMessage("bad_path"));
    expect(() => assertEditFilePath("  ")).toThrow(editFileErrorMessage("bad_path"));
  });

  test("обычный путь проходит", () => {
    expect(() => assertEditFilePath("/workspace/a.txt")).not.toThrow();
    expect(() => assertEditFilePath("notes.txt")).not.toThrow();
  });
});

describe("countOccurrences", () => {
  test("непересекающиеся вхождения", () => {
    expect(countOccurrences("aaa", "aa")).toBe(1);
    expect(countOccurrences("ababab", "ab")).toBe(3);
  });
});

describe("buildDiffRows", () => {
  test("между далёкими правками вставляет пропуск", () => {
    const oldContent = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";
    const newContent = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "J", "k"].join("\n") + "\n";
    const rows = buildDiffRows(oldContent, newContent);
    expect(rows.some((row) => row.kind === "skip")).toBe(true);
    const skip = rows.find((row) => row.kind === "skip");
    expect(skip && skip.kind === "skip" ? skip.skipped : 0).toBeGreaterThan(0);
  });
});
