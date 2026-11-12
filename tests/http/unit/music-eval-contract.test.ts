import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import {
  MUSIC_LEVEL_COMMANDS, MUSIC_PROJECT as P, musicWorkflowGates, musicWorkflowCompleted,
} from "../../../evals/music/fixtures";
import { allMusicStubs, event, history } from "./music-eval-support";
import recordings from "../../../evals/fixtures/music/contract-records.json";
import cases from "../../../evals/fixtures/music/history-v2.json";
import audit from "../../../evals/fixtures/music/integration.json";
import project from "../../../evals/fixtures/music/project.json";
import { entriesPattern } from "../../../evals/music/operation-patterns";

async function replay(index: number) {
  const playback = new StubPlayback(await allMusicStubs());
  const outcomes = new Map<string, { failed: boolean; output: unknown }>();
  const events = cases.cases[index].events.map(row => {
    if (row.type === "actions.requested") {
      for (const action of row.data.actions ?? []) if (action.kind === "tool-call" && "toolName" in action) {
        const answer = playback.call({ callId: action.callId, tool: action.toolName!, input: action.input });
        if (answer.kind !== "stub") throw new Error("Real execution escaped");
        outcomes.set(action.callId, { failed: "throw" in answer.outcome,
          output: "throw" in answer.outcome ? answer.outcome.throw!.message : answer.outcome.response });
      }
      return event(row.type, row.data);
    }
    const result = row.data.result!;
    if (result.kind === "load-skill-result") return event(row.type, row.data);
    const answer = outcomes.get(result.callId)!;
    return event(row.type, { status: answer.failed ? "failed" : "completed", result: { ...result, output: answer.output } });
  });
  return { events, outcomes };
}

test("все 174 реальных вызова проходят настоящий native matcher по независимо просмотренной матрице", async () => {
  let count = 0;
  for (const scenario of cases.cases) {
    const playback = new StubPlayback(await allMusicStubs());
    for (const call of scenario.calls) {
      const answer = playback.call({ callId: call.callId, tool: call.tool, input: call.input });
      expect(answer.kind).toBe("stub");
      if (answer.kind !== "stub") throw new Error("No stub");
      const retired: Record<string, string> = {
        "source-edit": "unsupported-edit", "journal-read": "unknown-read", "directory-public": "unknown-read",
        "caption-doc": "isolate-other-pages", "music-help": "unsupported-command",
      };
      const expected = call.rule.startsWith("diagnostic-") ? "unsupported-command" : retired[call.rule] ?? call.rule;
      expect(answer.ruleId).toBe(expected);
      if (expected === call.rule) {
        expect("throw" in answer.outcome).toBe(call.error);
        if (call.exitCode !== undefined) expect(answer.outcome).toMatchObject({ response: { exitCode: call.exitCode } });
      } else if (expected !== "music-invalid") expect(answer.outcome).toHaveProperty("throw");
      count++;
    }
  }
  expect(cases.cases.map(scenario => scenario.calls.length)).toEqual([68, 46, 60]);
  expect(count).toBe(174);
  expect((await allMusicStubs()).length).toBe(100);
});

test("исторический case 0 завершается целиком; case 1 требует отсутствующие музыкальные окна; case 2 сохраняет строгий барьер", async () => {
  expect(musicWorkflowCompleted((await replay(0)).events)).toBe(true);
  const second = await replay(1);
  expect(musicWorkflowGates(second.events)).toMatchObject({ generation: true, frames: true, isolatedRenders: true, separateLevels: false, finalMixRender: false });
  const third = await replay(2);
  expect(musicWorkflowGates(third.events)).toMatchObject({ generation: true, frames: true, isolatedRenders: false, separateLevels: false, finalMixRender: false, probe: false });
});

test.each([1, 2])("полное продолжение case %s после просмотра: новые stems, четыре замера, NOTES, финал и все проверки", async index => {
  const original = await replay(index);
  const h = await history();
  // Existing native replay retains exact request/completion ordering. The new
  // action IDs use a separate namespace from the historical IDs.
  h.events.push(...original.events);
  h.levels(); h.journal(); h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(recordings.probes.map(profile => profile.id))("probe %s возвращает именно записанный запрошенный формат, включая stdout/stderr", async id => {
  const profile = recordings.probes.find(profile => profile.id === id)!;
  const h = await history();
  for (const file of profile.files) {
    const actual = h.bash(`npx remotion ${profile.args.join(" ")} ${file}`);
    expect(actual.failed).toBe(false);
    expect(actual.output).toEqual(profile.output);
  }
});

test("порядок полей и независимых probe-флагов не меняет проекцию; лишние/повторённые поля не получают полный ответ", async () => {
  const h = await history();
  const result = h.bash('npx remotion ffprobe -of "default=noprint_wrappers=1" -show_entries "format=duration:stream=duration,height,width,codec_type,codec_name" -loglevel error out/final.mp4');
  expect(result.output).toEqual(recordings.probes.find(profile => profile.id === "selected-default=nw=1")!.output);
  for (const fields of ["codec_type,duration,bit_rate", "codec_type,codec_type", "codec_type,duration,width"]) {
    expect(h.bash(`npx remotion ffprobe -v error -show_entries stream=${fields} -of json out/voice-only.wav`).failed).toBe(true);
  }
  expect(entriesPattern("stream=codec_type,duration")).not.toContain("bit_rate");
});

test.each(["whole-json", "whole-json-quiet", "whole-default", "selected-json", "selected-default=nw=1", "selected-stream"])("полное доказательство последнего MP4 через %s", async id => {
  const h = await history(); h.prepare(); h.frames(); h.levels(); h.journal(); h.render();
  h.bash("stat -c %s out/final.mp4");
  const profile = recordings.probes.find(profile => profile.id === id)!;
  h.bash(`npx remotion ${profile.args.join(" ")} out/final.mp4`);
  h.bash("npx remotion ffmpeg -i out/final.mp4 -vn -af loudnorm=print_format=json -f null -");
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test("раздельные selector/CSV-проекции объединяются только для одной последней версии MP4", async () => {
  const h = await history(); h.prepare(); h.frames(); h.levels(); h.journal(); h.render();
  const probe = (id: string) => {
    const profile = recordings.probes.find(profile => profile.id === id)!;
    h.bash(`npx remotion ${profile.args.join(" ")} out/final.mp4`);
  };
  probe("duration-csv=p=0");
  expect(musicWorkflowGates(h.events).probe).toBe(false);
  probe("audio");
  expect(musicWorkflowGates(h.events).probe).toBe(false);
  probe("dimensions"); probe("types");
  // The container is not a substitute for an unqueried video stream duration.
  expect(musicWorkflowGates(h.events).probe).toBe(false);
  probe("video");
  expect(musicWorkflowGates(h.events).probe).toBe(true);
  h.render();
  probe("duration-csv=p=0"); probe("audio");
  expect(musicWorkflowGates(h.events).probe).toBe(false);
  probe("video");
  expect(musicWorkflowGates(h.events).probe).toBe(true);
});

test("CSV types/dimensions/container alone and probes of the WAV never prove final audio duration", async () => {
  const h = await history(); h.prepare(); h.frames(); h.levels(); h.journal(); h.render();
  for (const id of ["dimensions", "types", "duration-csv=p=0", "stem-json"]) {
    const profile = recordings.probes.find(profile => profile.id === id)!;
    h.bash(`npx remotion ${profile.args.join(" ")} ${profile.files[0]}`);
  }
  expect(musicWorkflowGates(h.events).probe).toBe(false);
});

test("полная музыка −24.38 — дополнительный замер; journal требует только четыре обязательных результата и их окна", async () => {
  const h = await history(); h.prepare(); h.frames(); h.levels();
  const diagnostic = h.bash("npx remotion ffmpeg -i out/music-only.wav -af loudnorm=print_format=json -f null - -vn");
  // Output URL must stay last; invalid positional shuffling is rejected.
  expect(diagnostic.failed).toBe(true);
  const full = h.bash("npx remotion ffmpeg -i out/music-only.wav -f null -af loudnorm=print_format=json -vn /dev/null");
  expect(full.output).toMatchObject({ exitCode: 0, stderr: JSON.stringify(recordings.levels.find(level => level.file === "out/music-only.wav" && level.scope === "full")!.measurement) });
  expect(JSON.parse((full.output as { stderr: string }).stderr).input_i).toBe("-24.38");
  h.journal(); h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(["paths", "windows", "outside-value"])("journal без обязательного %s не засчитывается", async missing => {
  const h = await history(); h.complete();
  const content = `out/voice-only.wav out/music-only.wav 1–3 4.91–5.12 9.91–10.12 14.91–15.12 -16.08 -15.20 -24.82 -17.76`;
  h.call("edit_file", { filePath: `${P}/NOTES.md`, newString: missing === "paths" ? content.replaceAll("out/", "unknown-") : missing === "windows" ? content.replace("4.91–5.12", "") : content.replace("-17.76", "-24.38") });
  expect(musicWorkflowGates(h.events).journal).toBe(false);
});

test.each(["voice-only", "music-only"])("выходные ss/t %s имеют собственные реальные измерения, но не доказывают входное окно loudnorm", async mode => {
  const h = await history(); h.prepare(); h.frames();
  h.bash(MUSIC_LEVEL_COMMANDS[0]); h.bash(MUSIC_LEVEL_COMMANDS[1]);
  h.bash(MUSIC_LEVEL_COMMANDS[2]); h.bash(MUSIC_LEVEL_COMMANDS[5]);
  h.bash(MUSIC_LEVEL_COMMANDS[mode === "voice-only" ? 4 : 3]);
  const row = recordings.levels.find(level => level.file === `out/${mode}.wav` && level.scope === "output")!;
  const answer = h.bash(`npx remotion ${row.args.join(" ")}`);
  expect(answer.output).toMatchObject({ exitCode: 0, stderr: JSON.stringify(row.measurement) });
  expect(musicWorkflowGates(h.events).separateLevels).toBe(false);
  h.bash(MUSIC_LEVEL_COMMANDS[mode === "voice-only" ? 3 : 4]);
  h.journal(); h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(["missing", "uniform", "error", "duplicate", "fake-text"])("pixel-check %s не заменяет JSON проверки шести JPEG", async fault => {
  const h = await history(); h.complete();
  for (const row of h.events) if (row.type === "action.result" && row.data.result.kind === "tool-result") {
    const output = row.data.result.output;
    if (!output || typeof output !== "object" || !("stdout" in output) || typeof output.stdout !== "string" || !output.stdout.includes('"extrema"')) continue;
    const lines = output.stdout.split("\n");
    if (fault === "missing") lines.shift();
    if (fault === "duplicate") lines[1] = lines[0];
    if (fault === "uniform") lines[0] = JSON.stringify({ path: "out/frames-1/element-000.jpeg", extrema: [[0, 0], [0, 0], [0, 0]], suspect: null });
    if (fault === "error") lines[0] = JSON.stringify({ path: "out/frames-1/element-000.jpeg", error: "unreadable" });
    row.data.result.output = { ...output, stdout: fault === "fake-text" ? "element-000.jpeg 1920x1080 ok" : lines.join("\n") };
  }
  expect(musicWorkflowGates(h.events).frames).toBe(false);
});

test("все записи привязаны к неизменённым исходникам, настоящим аудиофайлам, JPEG и текущему checker", () => {
  expect(recordings.sourceSha256).toBe(project.sourceSha256);
  expect(recordings.artifacts).toEqual(Object.fromEntries(Object.entries(audit.files).map(([file, metadata]) => [file, metadata.sha256])));
  expect(createHash("sha256").update(readFileSync("agent/skills/frame-review/scripts/check-frames.py")).digest("hex")).toBe(recordings.checkerSha256);
  expect(recordings.mediaInputs).toHaveLength(4);
  expect(recordings.pixels.relative.stderr).toBe("");
});

test.each(["width", "video-duration", "audio-duration", "missing-audio", "audio-na"])("probe с неподтверждённым/неверным %s не считается доказательством", async fault => {
  const h = await history(); h.complete();
  for (const row of h.events) if (row.type === "action.result" && row.data.result.kind === "tool-result") {
    const output = row.data.result.output;
    if (!output || typeof output !== "object" || !("stdout" in output) || typeof output.stdout !== "string") continue;
    let data;
    try { data = JSON.parse(output.stdout); } catch { continue; }
    if (!Array.isArray(data.streams) || !data.format) continue;
    if (fault === "width") data.streams[0].width = 1280;
    if (fault === "video-duration") data.streams[0].duration = "19";
    if (fault === "audio-duration") data.streams[1].duration = "18";
    if (fault === "missing-audio") data.streams.pop();
    if (fault === "audio-na") data.streams[1].duration = "N/A";
    row.data.result.output = { ...output, stdout: JSON.stringify(data) };
  }
  expect(musicWorkflowGates(h.events).probe).toBe(false);
});

test("format fallback допустим для запрошенного N/A video.duration, но не для audio.duration", async () => {
  const h = await history(); h.complete();
  for (const row of h.events) if (row.type === "action.result" && row.data.result.kind === "tool-result") {
    const output = row.data.result.output;
    if (!output || typeof output !== "object" || !("stdout" in output) || typeof output.stdout !== "string") continue;
    let data;
    try { data = JSON.parse(output.stdout); } catch { continue; }
    if (!Array.isArray(data.streams) || !data.format) continue;
    data.streams[0].duration = "N/A";
    row.data.result.output = { ...output, stdout: JSON.stringify(data) };
  }
  expect(musicWorkflowGates(h.events).probe).toBe(true);
});

test("частичные ответы разных WAV/MP4 и старой версии финала не складываются в фиктивную полную проверку", async () => {
  const h = await history(); h.prepare(); h.frames(); h.levels(); h.journal(); h.render();
  h.bash("npx remotion ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,duration -of default=nw=1 out/final.mp4");
  h.bash("npx remotion ffprobe -v error -show_entries stream=codec_type,duration -of json out/voice-only.wav");
  expect(musicWorkflowGates(h.events).probe).toBe(false);
  h.render();
  h.bash("npx remotion ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,duration -of default=nw=1 out/final.mp4");
  expect(musicWorkflowGates(h.events).probe).toBe(false);
});

test("каждый probe-профиль сохраняет ответ при развороте независимых опций и положении входного файла первым", async () => {
  const h = await history();
  let checked = 0;
  for (const profile of recordings.probes) {
    const options = profile.args.slice(1);
    const groups: string[][] = [];
    for (let at = 0; at < options.length;) {
      const size = options[at] === "-show_streams" || options[at] === "-show_format" ? 1 : 2;
      groups.push(options.slice(at, at + size));
      at += size;
    }
    const reverse = groups.toReversed().flat().join(" ");
    const command = `npx remotion ffprobe ${profile.files[0]}${reverse ? ` ${reverse}` : ""}`;
    expect(h.bash(command).output, profile.id).toEqual(profile.output);
    checked++;
  }
  expect(checked).toBe(19);
});

test.each(["trim", "gain"])("финальный peak из %s-диагностики не заменяет замер целой неизменённой смеси", async fault => {
  const h = await history(); h.complete();
  for (const row of h.events) if (row.type === "actions.requested") for (const action of row.data.actions) {
    if (action.kind !== "tool-call" || typeof action.input.command !== "string" || !action.input.command.includes("-i out/final.mp4 -vn -af")) continue;
    action.input = { ...action.input, command: action.input.command.replace("-vn -af loudnorm", fault === "trim" ? "-ss 1 -t 2 -vn -af loudnorm" : "-vn -af volume=0.1,loudnorm") };
  }
  expect(musicWorkflowGates(h.events).peak).toBe(false);
});

test("парные пути/JSON и перестановки опций сохраняют полный workflow без изменения gain или области анализа", async () => {
  const h = await history(); h.prepare(); h.frames();
  h.bash(`mkdir -p '${P}/out'`);
  h.bash('npx remotion render "src/index.ts" Main "out/voice-only.wav" --props="{\\"audioMode\\":\\"voice-only\\"}"');
  h.bash("npx remotion render 'src/index.ts' Main 'out/music-only.wav' --props='{\"audioMode\":\"music-only\"}'");
  h.bash('npx remotion ffmpeg -hide_banner -i "out/voice-only.wav" -f "null" -filter:a "loudnorm=print_format=json" -vn /dev/null');
  for (const file of ["voice-only", "music-only"]) {
    h.bash(`npx remotion ffmpeg -t '2' -ss '1' -i out/${file}.wav -af loudnorm=print_format=json -vn -f null /dev/null`);
  }
  h.bash(MUSIC_LEVEL_COMMANDS[5]);
  h.call("edit_file", { filePath: `${P}/NOTES.md`, newString: "out/voice-only.wav. out/music-only.wav. 1-3 4,91-5,12 9,91-10,12 14,91-15,12; -16,08 -15,20 -24,82 -17,76", overwrite: true });
  h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});
