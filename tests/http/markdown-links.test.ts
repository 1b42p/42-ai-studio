/**
 * Разбор ссылок на файлы песочницы (#8): одна чистая функция для сервера
 * (копирование) и браузера (отрисовка). Вход — сырой `url` узла Markdown.
 */
import { describe, expect, test } from "vitest";

import {
  parseSandboxLinks,
  resolveSandboxFilePath,
  resolveSandboxPath,
  SANDBOX_FILE_PREFIX,
  SANDBOX_FILE_REJECTED_URL,
  sandboxFileUrl,
} from "../../lib/media/sandbox-path";

describe("адрес файла песочницы", () => {
  const table: ReadonlyArray<readonly [string, ReturnType<typeof resolveSandboxPath>]> = [
    ["/workspace/out/final.mp4", { kind: "file", path: "/workspace/out/final.mp4" }],
    ["out/final.mp4", { kind: "file", path: "/workspace/out/final.mp4" }],
    ["./out/final.mp4", { kind: "file", path: "/workspace/out/final.mp4" }],
    ["out/my%20video.mp4", { kind: "file", path: "/workspace/out/my video.mp4" }],
    ["out/100%25.mp4", { kind: "file", path: "/workspace/out/100%.mp4" }],
    ["out/a%2541.txt", { kind: "file", path: "/workspace/out/a%41.txt" }],
    ["out/final.mp4?v=2", { kind: "file", path: "/workspace/out/final.mp4" }],
    ["out/final.mp4#t=5", { kind: "file", path: "/workspace/out/final.mp4" }],
    ["https://example.com/a.mp4", { kind: "external" }],
    ["mailto:author@example.com", { kind: "external" }],
    ["data:image/png;base64,AAAA", { kind: "external" }],
    ["file:///workspace/x", { kind: "external" }],
    ["//host/x", { kind: "external" }],
    ["#якорь", { kind: "external" }],
    ["/etc/passwd", { kind: "rejected", path: "/etc/passwd", reason: "outside_workspace" }],
    [
      "/workspace/../etc/passwd",
      { kind: "rejected", path: "/etc/passwd", reason: "outside_workspace" },
    ],
    ["../x", { kind: "rejected", path: "/x", reason: "outside_workspace" }],
    ["%2e%2e/x", { kind: "rejected", path: "/x", reason: "outside_workspace" }],
    ["/workspace", { kind: "rejected", path: "/workspace", reason: "outside_workspace" }],
    ["%00", { kind: "rejected", path: "%00", reason: "outside_workspace" }],
    ["out/%00.png", { kind: "rejected", path: "out/%00.png", reason: "outside_workspace" }],
    ["out/%ZZ.png", { kind: "rejected", path: "out/%ZZ.png", reason: "outside_workspace" }],
    ["out\\final.mp4", { kind: "rejected", path: "out\\final.mp4", reason: "outside_workspace" }],
  ];

  for (const [url, expected] of table) {
    test(JSON.stringify(url), () => {
      expect(resolveSandboxPath(url)).toEqual(expected);
    });
  }

  test("управляющий символ отвергается", () => {
    expect(resolveSandboxPath("out/\u0001.png")).toEqual({
      kind: "rejected",
      path: "out/\u0001.png",
      reason: "outside_workspace",
    });
  });

  test("вложенный путь с точками остаётся внутри рабочей области", () => {
    expect(resolveSandboxPath("out/./frames/../frame.png")).toEqual({
      kind: "file",
      path: "/workspace/out/frame.png",
    });
  });

  test("файловый путь не раскодируется повторно", () => {
    expect(resolveSandboxFilePath("/workspace/out/100%.mp4")).toEqual({
      kind: "file",
      path: "/workspace/out/100%.mp4",
    });
    expect(resolveSandboxFilePath("/workspace/out/a%41.txt")).toEqual({
      kind: "file",
      path: "/workspace/out/a%41.txt",
    });
    expect(resolveSandboxFilePath("../x")).toEqual({
      kind: "rejected",
      path: "/x",
      reason: "outside_workspace",
    });
  });
});

describe("ссылки Markdown", () => {
  test("собирает ссылки, картинки, определения и их ссылки в порядке появления", () => {
    const markdown = [
      "Вот ![кадр](out/frame.png) и [ролик](out/final.mp4).",
      "",
      "[неиспользованное]: ./out/extra.mp4",
      "",
      "![ещё][кадр] [внешняя](https://example.com/a.mp4) [опасная](/etc/passwd)",
      "",
      "[кадр]: out/frame.png",
    ].join("\n");

    expect(parseSandboxLinks(markdown)).toEqual([
      { kind: "file", path: "/workspace/out/frame.png" },
      { kind: "file", path: "/workspace/out/final.mp4" },
      { kind: "file", path: "/workspace/out/extra.mp4" },
      { kind: "rejected", path: "/etc/passwd", reason: "outside_workspace" },
    ]);
  });

  test("уникальные ссылки идут в порядке появления, повторы отбрасываются", () => {
    const markdown = "[a](out/a.mp4) [b](out/b.mp4) [снова](out/a.mp4) [../x](%2e%2e/x)";
    expect(parseSandboxLinks(markdown)).toEqual([
      { kind: "file", path: "/workspace/out/a.mp4" },
      { kind: "file", path: "/workspace/out/b.mp4" },
      { kind: "rejected", path: "/x", reason: "outside_workspace" },
    ]);
  });

  test("сырой HTML с путём не считается ссылкой", () => {
    expect(parseSandboxLinks('<a href="out/final.mp4">ролик</a>')).toEqual([]);
  });

  test("незавершённая ссылка потока не считается ссылкой", () => {
    // В браузере её достраивает remend до remark-плагина; сервер видит
    // только завершённый текст сообщения.
    expect(parseSandboxLinks("Эхо: [ролик](out/final.mp4")).toEqual([]);
  });
});

describe("адрес для компонентов Streamdown", () => {
  test("путь кодируется целиком и раскодируется обратно", () => {
    expect(sandboxFileUrl("/workspace/out/my video.mp4")).toBe(
      `${SANDBOX_FILE_PREFIX}%2Fworkspace%2Fout%2Fmy%20video.mp4`,
    );
    expect(SANDBOX_FILE_REJECTED_URL).toBe("/__sandbox-file-rejected");
  });
});
