import { expect, test } from "vitest";
import { musicWorkflowCompleted, musicWorkflowGates, matchingMusicSpeech, musicFinalLink, MUSIC_PROJECT as P } from "../../../evals/music/fixtures";
import { history } from "./music-eval-support";

test("неизменяемый проект проходит весь контракт без трёх edit_file", async () => {
  const h = await history(); h.complete();
  expect(musicWorkflowGates(h.events)).toEqual(Object.fromEntries(Object.keys(musicWorkflowGates(h.events)).map(key => [key, true])));
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(["generation", "timings", "pixels", "frame-read", "voice-render", "music-render", "voice-full", "voice-window", "music-window", "outside", "journal", "final", "size", "probe", "peak"])("отсутствие %s не заменяется кэшем, обещанием или чужой проверкой", async stage => {
  const h = await history(); h.complete();
  const filtered = h.events.filter(item => {
    if (item.type !== "actions.requested") return true;
    return !item.data.actions.some(action => {
      if (action.kind !== "tool-call") return false;
      const command = String(action.input.command ?? "");
      if (stage === "generation") return action.toolName === "speak";
      if (stage === "timings") return String(action.input.filePath).endsWith("scene-01.words.json");
      if (stage === "pixels") return command.includes("check-frames.py");
      if (stage === "frame-read") return String(action.input.filePath).endsWith("element-100.jpeg");
      if (stage === "journal") return action.toolName === "edit_file";
      const key = { "voice-render": "Main out/voice-only.wav", "music-render": "Main out/music-only.wav", "voice-full": "ffmpeg -i out/voice-only.wav", "voice-window": "-t 2 -i out/voice-only.wav", "music-window": "-t 2 -i out/music-only.wav", outside: "-filter_complex", final: "Main out/final.mp4", size: "stat -c", probe: "ffprobe", peak: "-i out/final.mp4 -vn -af loudnorm" }[stage];
      return !!key && command.includes(key);
    });
  });
  expect(musicWorkflowCompleted(filtered)).toBe(false);
});

test.each([{ voice: "ru-RU-DmitryNeural" }, { rate: 100 }, { rate: -10 }, { language: "en-US", voice: "en-US-AvaNeural" }])("вход озвучки %j не маскируется правильным результатом", async wrong => {
  const h = await history(); h.complete();
  for (const item of h.events) if (item.type === "actions.requested") for (const action of item.data.actions) {
    if (action.kind === "tool-call" && action.toolName === "speak") action.input = { ...action.input, ...Object.fromEntries(Object.entries(wrong).filter(([, v]) => v !== undefined)) };
  }
  expect(musicWorkflowCompleted(h.events)).toBe(false);
});

test.each(["wrong-level", "mixed-file", "different-window", "voice-gain", "outside-in-speech", "short-outside", "wrong-frames", "muted-final"])("подмена %s не проходит проверку событий", async fault => {
  const h = await history(); h.complete();
  for (const item of h.events) {
    if (item.type === "actions.requested") for (const action of item.data.actions) {
      if (action.kind !== "tool-call" || typeof action.input.command !== "string") continue;
      let command = action.input.command;
      if (command.includes("-t 2 -i out/music-only.wav")) {
        if (fault === "mixed-file") command = command.replace("out/music-only.wav", "out/final.mp4");
        if (fault === "different-window") command = command.replace("-ss 1", "-ss 6");
        if (fault === "voice-gain") command = command.replace("-af loudnorm", "-af volume=0.1,loudnorm");
      }
      if (command.includes("-filter_complex")) {
        if (fault === "outside-in-speech") command = command.replace("start=4.91:end=5.12", "start=1:end=1.5");
        if (fault === "short-outside") command = command.replace("end=5.12", "end=4.92").replace("end=10.12", "end=9.92").replace("end=15.12", "end=14.92");
      }
      if (fault === "wrong-frames") command = command.replace("--frames=0,100,150,300,450,599", "--frames=0,37,150,300,450,599");
      if (fault === "muted-final" && command.endsWith("Main out/final.mp4")) command += " --props='{\"fixtureVisualOnly\":true}'";
      action.input = { ...action.input, command };
    }
    if (fault === "wrong-level" && item.type === "action.result" && item.data.result.kind === "tool-result") {
      const output = item.data.result.output;
      if (typeof output === "object" && output && "stderr" in output && typeof output.stderr === "string" && output.stderr.includes('"input_i":"-24.82"')) item.data.result.output = { ...output, stderr: output.stderr.replace('"input_i":"-24.82"', '"input_i":"-20.00"') };
    }
  }
  expect(musicWorkflowCompleted(h.events)).toBe(false);
});

test("проверки до рендера и рендер до раздельных измерений не засчитываются", async () => {
  const h = await history(); h.prepare(); h.frames(); h.render(); h.levels(); h.journal(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(false);
});
test("повторное идентичное копирование шаблонов допустимо", async () => {
  const h = await history(); h.prepare();
  const copied = h.bash(`cp "$HOME/.agents/skills/music-synthesis/templates/ducking.ts" ${P}/src/ducking.ts && cp "$HOME/.agents/skills/music-synthesis/templates/BackgroundMusic.tsx.template" ${P}/src/BackgroundMusic.tsx`);
  expect(copied.failed).toBe(false);
  h.frames(); h.levels(); h.journal(); h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});
test("default ru и обычная скорость эквивалентны Светлане", () => {
  for (const input of [{}, { language: "ru", rate: 0 }, { voice: "ru-RU-SvetlanaNeural", language: "en-US" }]) expect(matchingMusicSpeech(input)).toBe(true);
  expect(musicFinalLink("[ролик](calm-bed/out/final.mp4)")).toBe(true);
  expect(musicFinalLink("Готово, музыка спокойная и тише во время речи")).toBe(false);
});

test.each([
  `echo changed > ${P}/src/Root.tsx`,
  `cp /tmp/changed.tsx ${P}/src/Root.tsx`,
  `python3 -c 'open("${P}/src/Root.tsx", "w").write("changed")'`,
])("даже ошибочно успешная запись защищённого исходника ломает gate: %s", async command => {
  const h = await history(); h.complete();
  const call = h.bash(command);
  const result = h.events[call.completed];
  if (result.type !== "action.result" || result.data.result.kind !== "tool-result") throw new Error("Missing action");
  result.data.status = "completed";
  result.data.result.output = { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  expect(musicWorkflowGates(h.events).immutableSources).toBe(false);
});
