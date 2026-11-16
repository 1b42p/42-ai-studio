import { describe, expect, test } from "vitest";
import ts from "typescript";

import { BROKEN_LAYOUT_NOTES, BROKEN_LAYOUT_ROOT } from "../../../agent/sandbox/eval-projects";

describe("проект для отрицательного видеосценария", () => {
  test("исходник композиции синтаксически корректен", () => {
    const { diagnostics } = ts.transpileModule(BROKEN_LAYOUT_ROOT, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
      reportDiagnostics: true,
    });
    expect((diagnostics ?? []).map(({ messageText }) => messageText)).toEqual([]);
  });

  test("первая сцена содержит проверяемые нарушения размеров и анимации", () => {
    expect(BROKEN_LAYOUT_ROOT).toContain("top: 80");
    expect(BROKEN_LAYOUT_ROOT).toContain("fontSize: 64");
    expect(BROKEN_LAYOUT_ROOT).toContain("interpolate(frame, [0, 20], [1, 2.2]);");
    expect(BROKEN_LAYOUT_ROOT).toContain("transform: `scale(${scale})`");
  });

  test("вторая сцена собрана по правилам, чтобы дефект был локальным", () => {
    expect(BROKEN_LAYOUT_ROOT).toContain('interpolate(frame, [0, 12], [0.35, 1], { extrapolateRight: "clamp" })');
    expect(BROKEN_LAYOUT_ROOT).toContain("fontSize: 150");
  });

  test("заметки проекта объявляют кадры проверенными без дефектов", () => {
    expect(BROKEN_LAYOUT_NOTES).toContain("| 1 | Утро начинается с движения | 0 | 59 |");
    expect(BROKEN_LAYOUT_NOTES).toContain("Дефекты: нет");
  });
});
