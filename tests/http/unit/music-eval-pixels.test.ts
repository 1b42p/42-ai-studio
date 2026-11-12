import { expect, test } from "vitest";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import { MUSIC_FRAMES, MUSIC_PROJECT as P, frameName, musicWorkflowCompleted, musicWorkflowGates } from "../../../evals/music/fixtures";
import recordings from "../../../evals/fixtures/music/contract-records.json";
import historyV3 from "../../../evals/fixtures/music/history-v3.json";
import { allMusicStubs, event, history } from "./music-eval-support";

const framesCommand = "npx remotion render src/index.ts Main out/frames-1 --frames=0,100,150,300,450,599 --image-format=jpeg --jpeg-quality=90";
const script = 'python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py"';
const pathFor = (frame: number, absolute = false) => `${absolute ? `${P}/` : ""}out/frames-1/${frameName(frame)}`;
const readFrames = (h: Awaited<ReturnType<typeof history>>) => MUSIC_FRAMES.forEach(frame => h.call("read_file", { filePath: `${P}/out/frames-1/${frameName(frame)}` }));
const finish = (h: Awaited<ReturnType<typeof history>>) => { h.levels(); h.journal(); h.render(); h.checks(); };

test("поштучные записи содержат настоящие extrema ровно своего кадра и исходное сообщение checker", () => {
  for (const style of ["relative", "absolute"] as const) {
    const full = recordings.pixels[style].stdout.trimEnd().split("\n");
    expect(recordings.singlePixels[style]).toHaveLength(6);
    for (const [index, output] of recordings.singlePixels[style].entries()) {
      expect(output).toEqual({ ...recordings.pixels[style], stdout: `${full[index]}\n${full[6]}\n` });
      expect(JSON.parse(full[index]).path).toBe(pathFor(MUSIC_FRAMES[index], style === "absolute"));
    }
  }
});

async function replay(index: number, originalFailures = false) {
  const playback = new StubPlayback(await allMusicStubs());
  const outcomes = new Map<string, { failed: boolean; output: unknown }>();
  return historyV3.cases[index].events.map(row => {
    if (row.type === "actions.requested") {
      for (const action of row.data.actions ?? []) if (action.kind === "tool-call" && "toolName" in action) {
        const answer = playback.call({ callId: action.callId, tool: action.toolName, input: action.input });
        if (answer.kind !== "stub") throw new Error("Real tool execution escaped");
        outcomes.set(action.callId, {
          failed: "throw" in answer.outcome,
          output: "throw" in answer.outcome ? answer.outcome.throw!.message : answer.outcome.response,
        });
      }
      return event(row.type, row.data);
    }
    const result = row.data.result!;
    if (result.kind === "load-skill-result") return event(row.type, row.data);
    const answer = outcomes.get(result.callId)!;
    return event(row.type, {
      status: answer.failed || (originalFailures && row.data.status === "failed") ? "failed" : "completed",
      result: { ...result, output: answer.output },
    });
  });
}

test("все 158 вызовов и 14 загрузок навыков нового отчёта проверены native matcher без исполнения", async () => {
  const rules = await allMusicStubs();
  expect(rules).toHaveLength(100);
  let count = 0;
  let pixels = 0;
  const skills: number[] = [];
  for (const scenario of historyV3.cases) {
    const playback = new StubPlayback(rules);
    skills.push(scenario.events.filter(row => row.type === "action.result" && row.data.result?.kind === "load-skill-result" && row.data.status === "completed").length);
    for (const call of scenario.calls) {
      const answer = playback.call({ callId: call.callId, tool: call.tool, input: call.input });
      expect(answer.kind).toBe("stub");
      if (answer.kind !== "stub") throw new Error("Unstubbed call");
      expect(answer.ruleId).toBe(call.rule);
      expect("throw" in answer.outcome).toBe(call.error);
      if (call.exitCode !== undefined) expect(answer.outcome).toMatchObject({ response: { exitCode: call.exitCode } });
      if (call.rule.startsWith("pixels-")) pixels++;
      count++;
    }
  }
  expect(historyV3.cases.map(row => row.calls.length)).toEqual([50, 52, 56]);
  expect(skills).toEqual([4, 5, 5]);
  expect(count).toBe(158);
  expect(pixels).toBe(14);
});

test("исходные остановки 0/2 не становятся полным успехом; case 1 сохраняет все подтверждения", async () => {
  for (const index of [0, 2]) {
    expect(musicWorkflowGates(await replay(index, true))).toMatchObject({ generation: true, timings: true, frames: false, finalMixRender: false });
    expect(musicWorkflowGates(await replay(index))).toMatchObject({ frames: true, isolatedRenders: false, finalMixRender: false });
  }
  expect(musicWorkflowCompleted(await replay(1))).toBe(true);
});

test.each([0, 2])("case %s: устранён pixel-блокер, полное причинно-позднее продолжение проходит", async index => {
  const h = await history();
  h.events.push(...await replay(index));
  finish(h);
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(["relative", "absolute"] as const)("полный %s explicit list возвращает ровно тот же настоящий ответ, что glob", async style => {
  const h = await history();
  const paths = MUSIC_FRAMES.map((frame, index) => {
    const path = pathFor(frame, style === "absolute");
    return index % 3 === 0 ? `'${path}'` : index % 3 === 1 ? `"${path}"` : path;
  });
  expect(h.bash(`${script} ${paths.join(" ")}`).output).toEqual(recordings.pixels[style]);
});

test.each(["relative", "absolute"] as const)("каждый отдельный %s JPEG имеет собственную записанную JSON-строку и не притворяется всей выборкой", async style => {
  const h = await history();
  for (const [index, frame] of MUSIC_FRAMES.entries()) {
    for (const scriptPath of ["/root/.agents/skills/frame-review/scripts/check-frames.py", '"/root/.agents/skills/frame-review/scripts/check-frames.py"', "'/root/.agents/skills/frame-review/scripts/check-frames.py'", "$HOME/.agents/skills/frame-review/scripts/check-frames.py", '"$HOME/.agents/skills/frame-review/scripts/check-frames.py"']) {
      for (const quote of ["", "'", '"']) {
        const path = pathFor(frame, style === "absolute");
        const answer = h.bash(`python3 ${scriptPath} ${quote}${path}${quote}`);
        expect(answer.failed).toBe(false);
        expect(answer.output).toEqual(recordings.singlePixels[style][index]);
        const rows = (answer.output as { stdout: string }).stdout.split("\n").filter(line => line.startsWith("{"));
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]).path).toBe(path);
      }
    }
  }
});

test("поштучные подмножества, произвольный порядок и смешанные пути накапливают все шесть до любого просмотра", async () => {
  const h = await history(); h.prepare(); h.bash(framesCommand);
  const order = [599, 150, 0, 450, 100, 300];
  for (const [index, frame] of order.entries()) {
    expect(h.bash(`${script} '${pathFor(frame, index % 2 === 0)}'`).failed).toBe(false);
    if (index < 5) expect(musicWorkflowGates(h.events).frames).toBe(false);
  }
  readFrames(h); finish(h);
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each([1, 5])("%s уникальных pixel-результатов и повторов недостаточно для шести", async count => {
  const h = await history(); h.prepare(); h.bash(framesCommand);
  for (const frame of MUSIC_FRAMES.slice(0, count)) h.bash(`${script} ${pathFor(frame)}`);
  for (let index = 0; index < 6; index++) h.bash(`${script} ${pathFor(0, true)}`);
  readFrames(h); finish(h);
  expect(musicWorkflowGates(h.events)).toMatchObject({ frames: false, isolatedRenders: false, finalMixRender: false });
});

test("никакой ранний JPEG read не засчитывается после позднего завершения последней pixel-проверки", async () => {
  const h = await history(); h.prepare(); h.bash(framesCommand);
  for (const frame of MUSIC_FRAMES) h.bash(`${script} ${pathFor(frame)}`);
  const pending = h.events.pop()!;
  readFrames(h);
  h.events.push(pending);
  finish(h);
  expect(musicWorkflowGates(h.events).frames).toBe(false);
  readFrames(h); finish(h);
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test("pixel-результаты двух генераций нельзя складывать; после новой записи нужны все шесть заново", async () => {
  const h = await history(); h.prepare(); h.bash(framesCommand);
  for (const frame of MUSIC_FRAMES.slice(0, 3)) h.bash(`${script} ${pathFor(frame)}`);
  h.bash(framesCommand);
  for (const frame of MUSIC_FRAMES.slice(3)) h.bash(`${script} ${pathFor(frame)}`);
  readFrames(h); finish(h);
  expect(musicWorkflowGates(h.events).frames).toBe(false);
  for (const frame of MUSIC_FRAMES.slice(0, 3)) h.bash(`${script} ${pathFor(frame, true)}`);
  readFrames(h); finish(h);
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

const paths = MUSIC_FRAMES.map(frame => pathFor(frame));
test.each([
  paths.slice(0, 2).join(" "),
  paths.toReversed().join(" "),
  paths.map((path, index) => index % 2 ? `${P}/${path}` : path).join(" "),
  `${paths[0]} ${paths[0]}`,
  "out/frames-1/element-001.jpeg",
  `${paths.join(" ")} extra`,
  `${paths.join(" ")}; true`,
  `${paths.join(" ")} && true`,
  `${paths.join(" ")} | sort`,
  `${paths[0]} > out/result.txt`,
  `${paths[0]} $(pwd)`,
  `"${paths[0]}'`,
  `${paths[0]}\ntrue`,
  '"out/frames-1/*.jpeg"',
])("неподдержанный список/небезопасный хвост %s не получает ни частичного успеха, ни чужих JSON", async inputs => {
  const h = await history();
  const answer = h.bash(`${script} ${inputs}`);
  expect(answer.ruleId).toBe("unsupported-command");
  expect(answer.failed).toBe(true);
  expect(answer.output).toContain("не системная ошибка");
  expect(answer.output).toContain("отдельными вызовами");
});

test.each(["wrong-order", "wrong-path", "extra", "duplicate", "unknown", "truncated"])("поддельный JSON %s не создаёт ложного доказательства", async fault => {
  const h = await history(); h.complete();
  for (const row of h.events) if (row.type === "action.result" && row.data.result.kind === "tool-result") {
    const output = row.data.result.output;
    if (!output || typeof output !== "object" || !("stdout" in output) || typeof output.stdout !== "string" || !output.stdout.includes('"extrema"')) continue;
    const lines = output.stdout.trimEnd().split("\n");
    if (fault === "wrong-order") [lines[0], lines[1]] = [lines[1], lines[0]];
    if (fault === "wrong-path") lines[0] = lines[0].replace("out/", `${P}/out/`);
    if (fault === "extra") lines.splice(6, 0, lines[0]);
    if (fault === "duplicate") lines[1] = lines[0];
    if (fault === "unknown") lines[0] = lines[0].replace("element-000", "element-001");
    row.data.result.output = { ...output, stdout: `${lines.join("\n")}\n`, truncated: fault === "truncated" };
  }
  expect(musicWorkflowGates(h.events).frames).toBe(false);
});
