import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CheckpointStore, isUnresolvedCheckpoint } from "./checkpoint-store.mjs";
import { acquireCheckpointLock } from "./checkpoint-lock.mjs";

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

async function invokeEve(root, args, checkpointDirectory) {
  const child = spawn(process.execPath, ["--import", resolve(root, "evals/support/collector-lifetime.mjs"),
    resolve(root, "node_modules/eve/bin/eve.js"), "eval", ...args], {
    cwd: root,
    env: { ...process.env, ...(checkpointDirectory ? { EVAL_CHECKPOINT_DIR: checkpointDirectory } : {}) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  let interrupted = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  const interrupt = () => { interrupted = true; child.kill("SIGINT"); };
  const terminate = () => { interrupted = true; child.kill("SIGTERM"); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const code = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    return { code, stdout, stderr, interrupted };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

export async function runTwoOfThree(args) {
  if (args.length === 0) {
    throw new Error("Запуск: node evals/support/two-of-three.mjs web --url http://localhost:3000");
  }
  const seen = new Set();
  const selectors = [];
  const options = [];
  let resume;
  let checkpointDirectory;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(arg)) throw new Error("Некорректное имя сценария.");
      selectors.push(arg);
      continue;
    }
    if (!["--url", "--timeout", "--max-concurrency", "--resume", "--checkpoint"].includes(arg) || seen.has(arg) ||
      !args[index + 1] || args[index + 1].startsWith("-")) {
      throw new Error(`Недопустимый или повторный параметр ${arg}.`);
    }
    seen.add(arg);
    if (arg === "--resume") { resume = resolve(args[++index]); continue; }
    if (arg === "--checkpoint") { checkpointDirectory = resolve(args[++index]); continue; }
    options.push(arg, args[++index]);
  }
  if (resume && checkpointDirectory) throw new Error("Используйте --resume либо --checkpoint, не оба сразу.");
  const original = resume ? JSON.parse(await readFile(resolve(resume, "manifest.json"), "utf8")) : undefined;
  if (selectors.length === 0 && !resume) throw new Error("Укажите сценарий или каталог оценок, например web.");
  if (!seen.has("--url")) options.push("--url", original?.target ?? "http://localhost:3000");
  const url = new URL(options[options.indexOf("--url") + 1]);
  if (!["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Оценки разрешены только против локального приложения.");
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  let ids;
  if (resume && selectors.length === 0) {
    ids = original?.caseIds;
  } else {
    const listing = await invokeEve(root, [...selectors, "--list", "--json"]);
    if (listing.interrupted) throw new Error("Сборщик остановлен до начала оценок.");
    if (listing.code !== 0) throw new Error("Не удалось получить список случаев eve eval.");
    const definitions = JSON.parse(listing.stdout);
    if (!Array.isArray(definitions)) throw new Error("eve eval --list не вернул список случаев.");
    ids = definitions.map(({ id }) => id);
  }
  const store = new CheckpointStore(resume ?? checkpointDirectory ??
    resolve(root, ".eve/evals/checkpoints", randomUUID()));
  if (!resume) {
    await mkdir(dirname(store.directory), { recursive: true, mode: 0o700 });
    try { await mkdir(store.directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Каталог checkpoint уже существует; для продолжения укажите --resume.");
      throw error;
    }
  }
  const release = await acquireCheckpointLock(store.directory);
  try {
    return await runCheckpoint({ store, url, ids, root, options });
  } finally { await release(); }
}

async function runCheckpoint({ store, url, ids, root, options }) {
  const manifest = await store.initialize({ target: url.href, caseIds: ids });
  await store.assertNotBlocked();
  summarizeTwoOfThree({ results: manifest.caseIds.map((id) => ({ id, verdict: "skipped" })) });
  const completed = new Set((await store.results()).map(({ id }) => id));
  const pending = ids.filter((id) => !completed.has(id));
  console.log(`Checkpoint: ${store.directory}`);
  console.log(`Сохранено случаев: ${completed.size}/${manifest.caseIds.length}; осталось выбранных: ${pending.length}.`);
  for (const id of pending) {
    const execution = await invokeEve(root, [id, ...options, "--json", "--strict"], store.directory);
    await writeFile(resolve(store.directory, `runner-${randomUUID()}.json`), execution.stdout, { mode: 0o600 });
    if (execution.interrupted) throw new Error(`Сборщик остановлен; продолжение: --resume ${store.directory}`);
    if (execution.stderr.includes("Eval cleanup failed:")) {
      await store.block("Завершение eve eval не удалось.");
      throw new Error(`Ошибка завершения eve eval; checkpoint: ${store.directory}`);
    }
    if (execution.code !== 0 && execution.code !== 1) {
      if (await store.readResult(id)) await store.block("Сборщик завершился с ошибкой после записи результата.");
      throw new Error(`eve eval прерван (код ${execution.code}); продолжение: --resume ${store.directory}`);
    }
    let partial;
    try { partial = JSON.parse(execution.stdout); }
    catch { throw new Error(`Нет итогового JSON eve; сохранённые случаи доступны через --resume ${store.directory}`); }
    if (execution.code === 1 && partial.results?.every(({ verdict }) => verdict === "passed")) {
      await store.block("Сборщик записал результат, но завершение eve eval не удалось.");
      throw new Error(`Ошибка завершения eve eval; checkpoint: ${store.directory}`);
    }
    if (!Array.isArray(partial.results) || partial.results.length !== 1 || partial.results[0].id !== id) {
      throw new Error("eve eval вернул другой набор случаев, чем был запрошен.");
    }
    if (isUnresolvedCheckpoint(partial.results[0])) {
      throw new Error(`Доставка сообщения требует проверки; случай остаётся незавершённым. Checkpoint: ${store.directory}`);
    }
    for (const result of partial.results) await store.writeResult(result);
    const result = partial.results[0];
    const balanceError = result.result.events?.some((event) => event.data?.details?.upstreamStatusCode === 402) ||
      [result.error, ...result.assertions.map((assertion) => assertion.errored ? assertion.message : "")]
        .some((message) => /insufficient balance|payment required|\b402\b/i.test(message ?? ""));
    if (balanceError) {
      throw new Error(`Провайдер отказал из-за баланса; дальнейшие случаи не запускаются. Checkpoint: ${store.directory}`);
    }
  }
  const results = await store.results();
  if (results.length !== manifest.caseIds.length) {
    throw new Error(`Серия неполна (${results.length}/${manifest.caseIds.length}); продолжение: --resume ${store.directory}`);
  }
  const report = {
    target: { kind: "remote", url: manifest.target, capabilities: { devRoutes: false } },
    results, startedAt: manifest.startedAt, completedAt: new Date().toISOString(),
    ...Object.fromEntries(["passed", "failed", "scored", "skipped"].map((verdict) =>
      [verdict, results.filter((result) => result.verdict === verdict).length])),
    errored: results.filter((result) => result.error !== undefined).length,
  };
  const directory = resolve(root, ".eve/evals/two-of-three");
  await mkdir(directory, { recursive: true });
  const artifact = resolve(directory, `${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(artifact, JSON.stringify(report), { mode: 0o600 });
  const summary = summarizeTwoOfThree(report);
  for (const { id, passed, accepted } of summary) {
    console.log(`${accepted ? "✓" : "✗"} ${id}: ${passed}/3`);
  }
  console.log(`Отчёт: ${artifact}`);
  return { accepted: summary.every(({ accepted }) => accepted), artifact, checkpoint: store.directory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTwoOfThree(process.argv.slice(2)).then(({ accepted }) => {
    process.exitCode = accepted ? 0 : 1;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
