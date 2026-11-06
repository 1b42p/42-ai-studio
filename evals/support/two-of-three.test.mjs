import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeTwoOfThree } from "./two-of-three.mjs";

const scenario = (id, verdicts) => verdicts.map((verdict, index) => ({
  id: `${id}/${String(index).padStart(4, "0")}`, verdict,
}));

test("считает 2/3 независимо для каждого сценария", () => {
  assert.deepEqual(summarizeTwoOfThree({ results: [
    ...scenario("web/read-link", ["passed", "failed", "passed"]),
    ...scenario("web/injection", ["failed", "passed", "failed"]),
  ] }), [
    { id: "web/read-link", passed: 2, total: 3, accepted: true },
    { id: "web/injection", passed: 1, total: 3, accepted: false },
  ]);
});

test("пропуски и мягкие оценки не являются успехами", () => {
  assert.deepEqual(summarizeTwoOfThree({ results: scenario("web/injection", ["passed", "scored", "skipped"]) }),
    [{ id: "web/injection", passed: 1, total: 3, accepted: false }]);
});

test("пустые, неполные, повторные и неверные результаты не дают ложный успех", () => {
  for (const report of [{}, { results: [] },
    { results: scenario("web/read-link", ["passed", "passed"]) },
    { results: [...scenario("web/read-link", ["passed", "passed", "passed"]),
      { id: "web/read-link/0000", verdict: "passed" }] },
    { results: [{ id: "web/read-link/0003", verdict: "passed" }] },
    { results: scenario("web/read-link", ["passed", "passed", "unknown"]) },
  ]) assert.throws(() => summarizeTwoOfThree(report));
});

const EXTERNAL_EVE = String.raw`
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { CheckpointStore } from '../../../evals/support/checkpoint-store.mjs';
const args = process.argv.slice(3);
const ids = ['check/scenario/0000', 'check/scenario/0001', 'check/scenario/0002'];
if (args.includes('--list')) {
  console.log(JSON.stringify(ids.map(id => ({id}))));
} else {
  const selected = args.filter(arg => ids.includes(arg));
  const store = new CheckpointStore(process.env.EVAL_CHECKPOINT_DIR);
  await store.initialize({target:args[args.indexOf('--url') + 1],caseIds:selected});
  let mode = '';
  try { mode = await readFile('mode', 'utf8'); } catch {}
  await store.bindRuntime(mode === 'model2' ? 'model2' : 'model1');
  await appendFile('calls.jsonl', JSON.stringify(selected) + '\n');
  const results = [];
  for (const id of selected) {
    let balance = false;
    try { await readFile('balance'); balance = true; } catch {}
    if (id.endsWith('0001')) {
      let interrupted = false;
      try { await readFile('interrupted'); interrupted = true; } catch {}
      if (!interrupted) { await writeFile('interrupted', 'yes'); process.exit(2); }
    }
    const result = {id,verdict:id.endsWith('0001')?'failed':'passed',assertions:[],
      startedAt:'2026-01-01T00:00:00.000Z',completedAt:'2026-01-01T00:00:01.000Z',
      result:{status:'waiting',events:[],traceContexts:[],derived:{toolCalls:[],skillLoads:[],subagentCalls:[],inputRequests:[],models:[]}}};
    if (balance) {
      result.verdict = 'failed';
      result.result.status = 'failed';
      result.result.events.push({type:'session.failed',data:{details:{upstreamStatusCode:402}}});
    }
    if (mode === 'judge402') {
      result.verdict = 'failed';
      result.assertions.push({name:'judge',severity:'gate',errored:true,message:'HTTP 402 Payment Required'});
    }
    await store.writeResult(result);
    results.push(result);
  }
  console.log(JSON.stringify({results}));
  if (mode === 'cleanup') { console.error('Eval cleanup failed: fixture'); process.exitCode = 1; }
}
`;

async function fixture() {
  const root = await mkdtemp("/tmp/opencode/eval-checkpoint-");
  await mkdir(join(root, "evals/support"), { recursive: true });
  await mkdir(join(root, "node_modules/eve/bin"), { recursive: true });
  for (const file of ["two-of-three.mjs", "checkpoint-store.mjs", "checkpoint-source.mjs", "checkpoint-lock.mjs", "collector-lifetime.mjs"]) {
    await copyFile(new URL(file, import.meta.url), join(root, "evals/support", file));
  }
  await writeFile(join(root, "node_modules/eve/package.json"), '{"type":"module"}');
  await writeFile(join(root, "node_modules/eve/bin/eve.js"), EXTERNAL_EVE);
  return root;
}

async function run(root, args) {
  const child = spawn(process.execPath, [join(root, "evals/support/two-of-three.mjs"), ...args], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  return { code, stdout, stderr };
}

test("после прерывания продолжает только незавершённые случаи и сохраняет проваленный результат", async () => {
  const root = await fixture();
  try {
    const checkpoint = join(root, ".eve/checkpoint");
    const first = await run(root, ["check/scenario", "--checkpoint", checkpoint]);
    assert.equal(first.code, 2, first.stderr);
    const original = await readFile(join(checkpoint, "result-check%2Fscenario%2F0000.json"), "utf8");
    const resumed = await run(root, ["--resume", checkpoint]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(await readFile(join(checkpoint, "result-check%2Fscenario%2F0000.json"), "utf8"), original);
    assert.deepEqual((await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse), [
      ["check/scenario/0000"], ["check/scenario/0001"],
      ["check/scenario/0001"], ["check/scenario/0002"],
    ]);
    const report = JSON.parse(await readFile(/Отчёт: (.+\.json)/u.exec(resumed.stdout)[1], "utf8"));
    assert.deepEqual(report.results.map(({ verdict }) => verdict), ["passed", "failed", "passed"]);
    assert.equal((await stat(checkpoint)).mode & 0o777, 0o700);
    assert.equal((await stat(join(checkpoint, "result-check%2Fscenario%2F0000.json"))).mode & 0o777, 0o600);
    const calls = await readFile(join(root, "calls.jsonl"), "utf8");
    assert.equal((await run(root, ["--resume", checkpoint])).code, 0);
    assert.equal(await readFile(join(root, "calls.jsonl"), "utf8"), calls);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("повреждённый checkpoint не запускает случаи заново", async () => {
  const root = await fixture();
  try {
    const checkpoint = join(root, ".eve/checkpoint");
    await run(root, ["check/scenario", "--checkpoint", checkpoint]);
    const path = join(checkpoint, "result-check%2Fscenario%2F0000.json");
    await writeFile(path, '{"id":"check/scenario/0000","verdict":"passed"}');
    const calls = await readFile(join(root, "calls.jsonl"), "utf8");
    const resumed = await run(root, ["--resume", checkpoint]);
    assert.equal(resumed.code, 2);
    assert.equal(await readFile(join(root, "calls.jsonl"), "utf8"), calls);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("после отказа провайдера 402 сохраняет ошибку и не запускает оставшиеся случаи", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "balance"), "empty");
    const checkpoint = join(root, ".eve/checkpoint");
    const result = await run(root, ["check/scenario", "--checkpoint", checkpoint]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /дальнейшие случаи не запускаются/u);
    assert.deepEqual(JSON.parse((await readFile(join(root, "calls.jsonl"), "utf8")).trim()), ["check/scenario/0000"]);
    const saved = JSON.parse(await readFile(join(checkpoint, "result-check%2Fscenario%2F0000.json"), "utf8"));
    assert.equal(saved.verdict, "failed");
    assert.equal(saved.result.events[0].data.details.upstreamStatusCode, 402);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("свежий запуск не переиспользует существующий checkpoint и не меняет его", async () => {
  const root = await fixture();
  try {
    const checkpoint = join(root, ".eve/checkpoint");
    await run(root, ["check/scenario", "--checkpoint", checkpoint]);
    const calls = await readFile(join(root, "calls.jsonl"), "utf8");
    const manifest = await readFile(join(checkpoint, "manifest.json"), "utf8");
    const retry = await run(root, ["check/scenario", "--checkpoint", checkpoint]);
    assert.equal(retry.code, 2);
    assert.match(retry.stderr, /укажите --resume/u);
    assert.equal(await readFile(join(root, "calls.jsonl"), "utf8"), calls);
    assert.equal(await readFile(join(checkpoint, "manifest.json"), "utf8"), manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("изменение исходников не смешивает старые и новые результаты", async () => {
  const root = await fixture();
  try {
    const checkpoint = join(root, ".eve/checkpoint");
    await run(root, ["check/scenario", "--checkpoint", checkpoint]);
    const calls = await readFile(join(root, "calls.jsonl"), "utf8");
    await writeFile(join(root, "evals/changed.eval.ts"), "export default [];\n");
    const resumed = await run(root, ["--resume", checkpoint]);
    assert.equal(resumed.code, 2);
    assert.match(resumed.stderr, /результаты разных версий не смешиваются/u);
    assert.equal(await readFile(join(root, "calls.jsonl"), "utf8"), calls);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("смена модели сервера или судьи не запускает оставшиеся случаи", async () => {
  const root = await fixture();
  try {
    const checkpoint = join(root, ".eve/checkpoint");
    await run(root, ["check/scenario", "--checkpoint", checkpoint]);
    const calls = await readFile(join(root, "calls.jsonl"), "utf8");
    await writeFile(join(root, "mode"), "model2");
    const resumed = await run(root, ["--resume", checkpoint]);
    assert.equal(resumed.code, 2);
    assert.match(resumed.stderr, /конфигурация сервера\/судьи изменились/u);
    assert.equal(await readFile(join(root, "calls.jsonl"), "utf8"), calls);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ответ 402 судьи также останавливает серию", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "mode"), "judge402");
    const result = await run(root, ["check/scenario"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /дальнейшие случаи не запускаются/u);
    assert.deepEqual(JSON.parse((await readFile(join(root, "calls.jsonl"), "utf8")).trim()), ["check/scenario/0000"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("продолжение не скрывает ошибку завершения уже записанного случая", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "mode"), "cleanup");
    const checkpoint = join(root, ".eve/checkpoint");
    assert.equal((await run(root, ["check/scenario", "--checkpoint", checkpoint])).code, 2);
    const calls = await readFile(join(root, "calls.jsonl"), "utf8");
    const resumed = await run(root, ["--resume", checkpoint]);
    assert.equal(resumed.code, 2);
    assert.match(resumed.stderr, /ошибки завершения/u);
    assert.equal(await readFile(join(root, "calls.jsonl"), "utf8"), calls);
  } finally { await rm(root, { recursive: true, force: true }); }
});
