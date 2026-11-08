/**
 * Образ песочницы и навыки Remotion (#14).
 * Тест читает Dockerfile и заголовки SKILL.md и не ходит в приложение:
 * версия образа, навыков и zod расходится — проверка падает.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

const REMOTION_VERSION = "4.0.538";
const ZOD_VERSION = "4.5.4";

const REMOTION_PACKAGES = [
  "remotion",
  "@remotion/cli",
  "@remotion/media",
  "@remotion/captions",
  "@remotion/google-fonts",
  "@remotion/transitions",
  "@remotion/shapes",
  "@remotion/layout-utils",
  "@remotion/effects",
  "@remotion/paths",
  "@remotion/noise",
  "@remotion/motion-blur",
  "@remotion/gif",
  "@remotion/zod-types",
] as const;

const REMOTION_SKILLS = [
  "remotion-create",
  "remotion-docs",
  "remotion-markup",
  "remotion-multimedia",
  "remotion-render",
  "remotion-captions",
  "remotion-interactivity",
] as const;

const root = path.resolve(import.meta.dirname, "../..");

function readRepo(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function listDirs(relativePath: string): string[] {
  const absolute = path.join(root, relativePath);
  try {
    return readdirSync(absolute).filter((name) => statSync(path.join(absolute, name)).isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Комментарий `# embed <путь>` … `# end embed` — текст, который декодирует соседний `RUN echo`. */
function embeddedFiles(dockerfile: string): Map<string, string> {
  const lines = dockerfile.split("\n");
  const files = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^# embed (\S+)$/.exec(lines[index] ?? "");
    if (!header) continue;
    const target = header[1];
    if (!target) continue;
    const body: string[] = [];
    index += 1;
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line === "# end embed") break;
      if (line.startsWith("# ")) body.push(line.slice(2));
      else if (line === "#") body.push("");
      else throw new Error(`Строка внутри embed ${target} не комментарий: ${line}`);
    }
    const encoded = lines[index + 1] ?? "";
    const command = /^RUN echo '([A-Za-z0-9+/=]+)' \| base64 -d > (\S+)$/.exec(encoded);
    expect(command, `после embed ${target} нет RUN echo | base64 -d`).not.toBeNull();
    expect(command?.[2]).toBe(target);
    const decoded = execFileSync("base64", ["-d"], { input: command?.[1] ?? "" }).toString("utf8");
    const commented = `${body.join("\n")}\n`;
    expect(decoded, target).toBe(commented);
    files.set(target, decoded);
  }
  return files;
}

test("версия Remotion в образе одна и совпадает с навыками и zod", () => {
  const dockerfile = readRepo("agent/sandbox/Dockerfile");
  expect(dockerfile).not.toMatch(/^(?:COPY|ADD)\b/m);

  expect(dockerfile.match(/^ARG REMOTION_VERSION=4\.0\.538$/gm)).toEqual([
    `ARG REMOTION_VERSION=${REMOTION_VERSION}`,
  ]);
  expect(dockerfile.match(/^ARG ZOD_VERSION=4\.5\.4$/gm)).toEqual([`ARG ZOD_VERSION=${ZOD_VERSION}`]);

  for (const name of REMOTION_PACKAGES) {
    expect(dockerfile, name).toContain(`"${name}@\${REMOTION_VERSION}"`);
  }
  expect(dockerfile).toContain(`"zod@\${ZOD_VERSION}"`);

  const files = embeddedFiles(dockerfile);
  expect(files.has("/usr/local/bin/sandbox-vcpu")).toBe(true);
  expect(files.has("/usr/local/bin/sandbox-selfcheck")).toBe(true);
  expect(files.get("/opt/remotion/src/Root.tsx")).toContain('id="Main"');

  const installed = listDirs("agent/skills").filter((name) => name.startsWith("remotion-"));
  expect(installed.toSorted()).toEqual([...REMOTION_SKILLS].toSorted());
  expect(listDirs(".agents/skills").filter((name) => name.startsWith("remotion-"))).toEqual([]);
  expect(listDirs(".claude/skills").filter((name) => name.startsWith("remotion-"))).toEqual([]);

  for (const name of REMOTION_SKILLS) {
    const skill = readRepo(`agent/skills/${name}/SKILL.md`);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill);
    expect(frontmatter, name).not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^version: 4\.0\.538$/m);
  }
});

test("навык sandbox-environment описывает среду песочницы", () => {
  const skill = readRepo("agent/skills/sandbox-environment/SKILL.md");
  const markers = [
    "2 vCPU",
    "4 ГБ",
    "3 ГБ",
    "df -h /workspace",
    "sandbox-vcpu",
    "nproc",
    "65 с",
    "outputDirectory",
    "137",
    "--disallow-parallel-encoding",
    "--concurrency=1",
    "ONNX",
    "10–15",
    "PyPI",
    "YouTube",
    "remotion.dev",
    "curl -sS -o /dev/null -w '%{http_code}'",
    "/opt/remotion",
    "npx create-video",
    "npx remotion add",
    "npx remotion ffmpeg",
    "npx remotion ffprobe",
    "fonts.googleapis.com",
    "frame-review",
    "read_page",
    "web_search",
    "llms.txt",
    "remotion-interactivity",
    "timeline-structure.md",
    "Whisper",
    "basic-captions",
    "Algolia",
    "pip install",
    "voiceover",
    "reading-documents",
    "id -u",
    "/workspace/<имя>/out/",
  ];
  for (const marker of markers) {
    expect(skill, marker).toContain(marker);
  }
});

test("инструкции видеографа сохраняют правила песочницы и файлов в пределах 200 строк", () => {
  const instructions = readRepo("agent/instructions.md");
  expect(instructions.trimEnd().split("\n").length).toBeLessThanOrEqual(200);
  for (const section of ["Роль", "Язык", "Уточнения", "План", "Порядок", "Проверка кадров", "Ответ", "Правки", "Неудача", "Ресурсы", "Инструменты"]) {
    expect(instructions).toContain(`# ${section}\n`);
  }
  expect(instructions).toContain("sandbox-environment");
  expect(instructions).toContain("frame-review");
  expect(instructions).toContain("серверными инструментами");
  expect(instructions).toContain("через `bash`");
  expect(instructions).toContain("read_page");
  expect(instructions).toContain("web_search");
  expect(instructions).toContain("Правки файлов");
  expect(instructions).toContain("[ролик](coffee-promo/out/coffee-promo.mp4)");
  expect(instructions).toContain("Относительные пути считаются от `/workspace`");
  expect(instructions).not.toContain("ask_question");
  expect(instructions).toContain("download_video");
  expect(instructions).toContain("повторяй больше двух раз");
});
