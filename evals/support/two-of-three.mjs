import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Ошибки, пропущенные и мягко оценённые случаи успехом не считаются. */
export function summarizeTwoOfThree(report) {
  if (!Array.isArray(report?.results) || report.results.length === 0) {
    throw new Error("eve eval не вернул результаты сценариев.");
  }
  const groups = new Map();
  for (const result of report.results) {
    const match = /^(.*)\/(000[0-2])$/.exec(result.id ?? "");
    if (!match || !["passed", "failed", "scored", "skipped"].includes(result.verdict)) {
      throw new Error(`Ожидался сценарий из трёх случаев, получен ${result.id ?? "неизвестный случай"}.`);
    }
    const [, id, index] = match;
    const group = groups.get(id) ?? new Map();
    if (group.has(index)) throw new Error(`Повтор результата ${result.id}.`);
    group.set(index, result.verdict);
    groups.set(id, group);
  }
  return [...groups].map(([id, cases]) => {
    if (cases.size !== 3) throw new Error(`В сценарии ${id} не три результата.`);
    const passed = [...cases.values()].filter((verdict) => verdict === "passed").length;
    return { id, passed, total: 3, accepted: passed >= 2 };
  });
}

async function main(args) {
  if (args.length === 0) {
    throw new Error("Запуск: node evals/support/two-of-three.mjs web --url http://localhost:3000");
  }
  const seen = new Set();
  const selectors = [];
  const options = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(arg)) throw new Error("Некорректное имя сценария.");
      selectors.push(arg);
      continue;
    }
    if (!["--url", "--timeout", "--max-concurrency"].includes(arg) || seen.has(arg) ||
      !args[index + 1] || args[index + 1].startsWith("-")) {
      throw new Error(`Недопустимый или повторный параметр ${arg}.`);
    }
    seen.add(arg);
    options.push(arg, args[++index]);
  }
  if (selectors.length === 0) throw new Error("Укажите сценарий или каталог оценок, например web.");
  if (!seen.has("--url")) options.push("--url", "http://localhost:3000");
  const url = new URL(options[options.indexOf("--url") + 1]);
  if (!["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Оценки разрешены только против локального приложения.");
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const child = spawn(process.execPath, [resolve(root, "node_modules/eve/bin/eve.js"), "eval",
    ...selectors, ...options, "--json", "--strict"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  const stop = (signal) => child.kill(signal);
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  }).finally(() => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  });
  const directory = resolve(root, ".eve/evals/two-of-three");
  await mkdir(directory, { recursive: true });
  const artifact = resolve(directory, `${new Date().toISOString().replaceAll(":", "-")}.json`);
  // Даже невалидный вывод сохраняется: не превращаем сбой раннера в успех.
  await writeFile(artifact, stdout, { mode: 0o600 });
  if (code !== 0 && code !== 1) throw new Error(`eve eval завершился с кодом ${code}; отчёт: ${artifact}`);
  let report;
  try { report = JSON.parse(stdout); }
  catch { throw new Error(`eve eval не вернул JSON; вывод: ${artifact}`); }
  const summary = summarizeTwoOfThree(report);
  if (stderr.includes("Eval cleanup failed:") ||
    (code === 1 && report.results.every(({ verdict }) => verdict === "passed"))) {
    throw new Error(`Ошибка завершения eve eval; отчёт: ${artifact}`);
  }
  for (const { id, passed, accepted } of summary) {
    console.log(`${accepted ? "✓" : "✗"} ${id}: ${passed}/3`);
  }
  console.log(`Отчёт: ${artifact}`);
  process.exitCode = summary.every(({ accepted }) => accepted) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
