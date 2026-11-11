import { expect, test } from "vitest";
import {
  commandWords,
  MUSIC_LEVEL_COMMANDS,
  MUSIC_PROJECT as P,
  MUSIC_SCENES,
  musicWorkflowCompleted,
  musicWorkflowGates,
} from "../../../evals/music/fixtures";
import { history } from "./music-eval-support";

type History = Awaited<ReturnType<typeof history>>;
const finalCommand = "npx remotion render src/index.ts Main out/final.mp4";
const framesCommand = "npx remotion render src/index.ts Main out/frames-1 --frames=0,100,150,300,450,599 --image-format=jpeg --jpeg-quality=90";
const musicCommand = `python3 "$HOME/.agents/skills/music-synthesis/scripts/make_music.py" --mood calm --seconds 20 --seed 1 --lufs -18 --out ${P}/public/music/bg`;
const speak = (h: History) => h.call("speak", {
  text: MUSIC_SCENES[0].text,
  voice: "ru-RU-SvetlanaNeural",
  rate: 0,
  outputPath: `${P}/public/voice/scene-01`,
});
const artifacts = ["music", "speak", "final", "voice-track", "music-track", "frames"] as const;
type Artifact = typeof artifacts[number];

function overwrite(h: History, artifact: Artifact) {
  if (artifact === "music") return h.bash(musicCommand);
  if (artifact === "speak") return speak(h);
  if (artifact === "final") return h.bash(finalCommand);
  if (artifact === "voice-track") return h.bash(MUSIC_LEVEL_COMMANDS[0]);
  if (artifact === "music-track") return h.bash(MUSIC_LEVEL_COMMANDS[1]);
  return h.bash(framesCommand);
}

function repair(h: History, artifact: Artifact) {
  if (artifact === "speak") h.call("read_file", { filePath: `${P}/public/voice/scene-01.words.json` });
  if (["music", "speak", "frames"].includes(artifact)) h.frames();
  if (artifact !== "final") { h.levels(); h.journal(); h.render(); }
  h.checks();
}

test.each(["'", '"'])("native matcher отказывает при непарной кавычке %s без частичного разбора", async quote => {
  const h = await history();
  const command = `npx remotion render ${quote}src/index.ts Main out/final.mp4`;
  const answer = h.bash(command);
  expect(answer.ruleId).toBe("unsupported-command");
  expect(answer.failed).toBe(true);
  expect(commandWords(command)).toEqual([]);
});

test.each(["'", '"'])("workflow не принимает непарную кавычку %s даже при ошибочном success", async quote => {
  const h = await history(); h.complete();
  for (const item of h.events) if (item.type === "actions.requested") {
    for (const action of item.data.actions) if (action.kind === "tool-call" && action.input.command === finalCommand) {
      action.input = { ...action.input, command: `npx remotion render ${quote}src/index.ts Main out/final.mp4` };
    }
  }
  expect(musicWorkflowGates(h.events).finalMixRender).toBe(false);
  expect(musicWorkflowCompleted(h.events)).toBe(false);
});

test.each(artifacts)("последняя запись %s аннулирует старые подтверждения; новый зависимый цикл восстанавливает их", async artifact => {
  const h = await history(); h.complete();
  overwrite(h, artifact);
  const gates = musicWorkflowGates(h.events);
  if (artifact === "speak") expect(gates.timings).toBe(false);
  if (["music", "speak", "frames"].includes(artifact)) expect(gates.frames).toBe(false);
  if (artifact.endsWith("track")) expect(gates.separateLevels).toBe(false);
  if (artifact === "final") expect([gates.fileSize, gates.probe, gates.peak]).toEqual([false, false, false]);
  if (artifact !== "final") h.render();
  expect(musicWorkflowCompleted(h.events)).toBe(false);
  repair(h, artifact);
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(artifacts)("pending запись %s блокирует старую историю и проверки, начавшиеся до её completion", async artifact => {
  const h = await history(); h.complete();
  overwrite(h, artifact);
  const completion = h.events.pop()!;
  expect(completion.type).toBe("action.result");
  expect(musicWorkflowCompleted(h.events)).toBe(false);
  // Attempt downstream work while the actual writer still owns the file.
  if (artifact === "speak") h.call("read_file", { filePath: `${P}/public/voice/scene-01.words.json` });
  if (artifact === "frames") {
    h.bash('python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/frames-1/*.jpeg');
    h.call("read_file", { filePath: `${P}/out/frames-1/element-100.jpeg` });
  }
  if (artifact.endsWith("track")) MUSIC_LEVEL_COMMANDS.slice(2).forEach(command => h.bash(command));
  h.checks();
  h.events.push(completion);
  expect(musicWorkflowCompleted(h.events)).toBe(false);
  repair(h, artifact);
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(["music", "speak", "final", "voice-track", "frames"] as const)("перекрывающиеся записи %s требуют причинно более поздней записи, независимо от порядка ответов", async artifact => {
  for (const reversed of [false, true]) {
    const h = await history(); h.complete();
    overwrite(h, artifact);
    const first = h.events.pop()!;
    overwrite(h, artifact);
    const second = h.events.pop()!;
    h.events.push(...(reversed ? [second, first] : [first, second]));
    expect(musicWorkflowCompleted(h.events)).toBe(false);
    repair(h, artifact);
    // Some repairs explicitly rewrite their own artifacts (frames/stems). For
    // generation/final this only rereads/rerenders downstream, which is insufficient.
    if (["music", "speak", "final"].includes(artifact)) expect(musicWorkflowCompleted(h.events)).toBe(false);
    overwrite(h, artifact);
    repair(h, artifact);
    expect(musicWorkflowCompleted(h.events)).toBe(true);
  }
});

test("тайминги, запрошенные до окончания последнего speak, не становятся свежими из-за позднего ответа read_file", async () => {
  const h = await history(); h.complete();
  speak(h);
  const voiceResult = h.events.pop()!;
  h.call("read_file", { filePath: `${P}/public/voice/scene-01.words.json` });
  const readResult = h.events.pop()!;
  h.events.push(voiceResult, readResult);
  h.frames(); h.levels(); h.journal(); h.render(); h.checks();
  expect(musicWorkflowGates(h.events).timings).toBe(false);
  repair(h, "speak");
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(["music-params", "voice-params", "track-mode", "frame-selection", "final-mode"])("успешная неподходящая перезапись %s не позволяет выбрать старую подходящую", async fault => {
  const h = await history(); h.complete();
  const artifact: Artifact = fault === "music-params" ? "music" : fault === "voice-params" ? "speak" :
    fault === "track-mode" ? "voice-track" : fault === "frame-selection" ? "frames" : "final";
  const write = overwrite(h, artifact);
  const requested = h.events[write.requested];
  if (requested.type !== "actions.requested") throw new Error("Missing request");
  const action = requested.data.actions[0];
  if (action.kind !== "tool-call") throw new Error("Missing tool call");
  // A completed write can be inappropriate despite a previously valid proof.
  // Keep the successful result and change its input, independently of the stubs.
  if (fault === "voice-params") action.input = { ...action.input, rate: 50 };
  else {
    let command = String(action.input.command);
    if (fault === "music-params") command = command.replace("--seconds 20", "--seconds 30");
    if (fault === "track-mode") command = command.replace('"voice-only"', '"mix"');
    if (fault === "frame-selection") command = command.replace("--frames=0,100", "--frames=0,37");
    if (fault === "final-mode") command += " --props='{\"fixtureVisualOnly\":true}'";
    action.input = { ...action.input, command };
  }
  h.checks();
  const gates = musicWorkflowGates(h.events);
  if (fault.endsWith("params")) expect(gates.generation).toBe(false);
  if (fault === "track-mode") expect(gates.isolatedRenders).toBe(false);
  if (fault === "frame-selection") expect(gates.frames).toBe(false);
  if (fault === "final-mode") expect(gates.finalMixRender).toBe(false);
  expect(musicWorkflowCompleted(h.events)).toBe(false);
  overwrite(h, artifact);
  repair(h, artifact);
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test("последний NOTES-снимок заменяет старые измерения, а не дополняет их задним числом", async () => {
  const h = await history(); h.complete();
  h.call("edit_file", { filePath: `${P}/NOTES.md`, newString: "Новый черновик без измерений", overwrite: true });
  expect(musicWorkflowGates(h.events).journal).toBe(false);
  h.journal();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test("новая дорожка того же режима по другому пути не наследует старые замеры режима", async () => {
  const h = await history(); h.complete();
  const write = h.bash(MUSIC_LEVEL_COMMANDS[0]);
  const requested = h.events[write.requested];
  if (requested.type !== "actions.requested" || requested.data.actions[0].kind !== "tool-call") throw new Error("Missing request");
  requested.data.actions[0].input = {
    ...requested.data.actions[0].input,
    command: MUSIC_LEVEL_COMMANDS[0].replace("out/voice-only.wav", "out/voice-new.wav"),
  };
  expect(musicWorkflowGates(h.events).separateLevels).toBe(false);
  expect(musicWorkflowCompleted(h.events)).toBe(false);
  repair(h, "voice-track");
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test("NOTES и финал, запрошенные до завершения последнего необходимого замера, не получают доказательство задним числом", async () => {
  const h = await history(); h.prepare(); h.frames(); h.levels();
  const lastLevel = h.events.pop()!;
  h.journal(); h.render(); h.checks();
  h.events.push(lastLevel);
  expect(musicWorkflowGates(h.events)).toMatchObject({ separateLevels: true, journal: false, finalMixRender: false });
  h.journal(); h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test("замер с поздним ответом не относится к дорожке, если он запрошен до completion её последней записи", async () => {
  const h = await history(); h.complete();
  h.bash(MUSIC_LEVEL_COMMANDS[0]);
  const renderResult = h.events.pop()!;
  h.bash(MUSIC_LEVEL_COMMANDS[2]);
  const levelResult = h.events.pop()!;
  h.events.push(renderResult, levelResult);
  h.bash(MUSIC_LEVEL_COMMANDS[3]);
  h.journal(); h.render(); h.checks();
  expect(musicWorkflowGates(h.events).separateLevels).toBe(false);
  h.bash(MUSIC_LEVEL_COMMANDS[2]);
  h.journal(); h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test("независимые параллельные записи разных артефактов не конфликтуют", async () => {
  const h = await history(); h.complete();
  speak(h);
  const voiceResult = h.events.pop()!;
  h.bash(musicCommand);
  const musicResult = h.events.pop()!;
  h.events.push(musicResult, voiceResult);
  repair(h, "speak");
  expect(musicWorkflowCompleted(h.events)).toBe(true);

  h.bash(MUSIC_LEVEL_COMMANDS[0]);
  const voiceTrackResult = h.events.pop()!;
  h.bash(MUSIC_LEVEL_COMMANDS[1]);
  const musicTrackResult = h.events.pop()!;
  h.events.push(voiceTrackResult, musicTrackResult);
  MUSIC_LEVEL_COMMANDS.slice(2).forEach(command => h.bash(command));
  h.journal(); h.render(); h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(true);
});

test.each(["music", "final", "voice-track"] as const)("возвращённый running bash для %s не считается завершившейся записью", async artifact => {
  const h = await history(); h.complete();
  const write = overwrite(h, artifact);
  const event = h.events[write.completed];
  if (event.type !== "action.result" || event.data.result.kind !== "tool-result") throw new Error("Missing result");
  event.data.result.output = { status: "running", jobId: "0123abcd", outputDirectory: "/tmp/.eve/jobs/0123abcd" };
  h.checks();
  expect(musicWorkflowCompleted(h.events)).toBe(false);
});

test.each(["'", '"'])("native matcher принимает только парные формы %s с альтернативами путей", async quote => {
  const h = await history();
  for (const command of [
    `npx remotion render ${quote}src/index.ts${quote} Main ${quote}out/final.mp4${quote}`,
    `cd ${quote}${P}${quote} && npx remotion render src/index.ts Main out/final.mp4`,
    `ls ${quote}.${quote}`,
    `ls ${quote}${P}${quote}`,
    `test -s ${quote}package.json${quote}`,
    `npx remotion ffprobe -show_streams -show_format -of ${quote}json${quote} ${quote}out/final.mp4${quote}`,
  ]) {
    const answer = h.bash(command);
    expect(answer.failed, command).toBe(false);
    expect(answer.output, command).toMatchObject({ exitCode: 0 });
  }
  for (const command of [
    `npx remotion render ${quote}src/index.ts Main out/final.mp4`,
    `npx remotion render src/index.ts Main out/final.mp4${quote}`,
    `ls ${quote}.`,
    `test -s ${quote}package.json`,
    `npx remotion ffprobe -show_streams -show_format -of ${quote}json out/final.mp4`,
    `npx remotion render ${quote}src/index.ts${quote === "'" ? '"' : "'"} Main out/final.mp4`,
  ]) {
    expect(h.bash(command).failed, command).toBe(true);
    expect(commandWords(command), command).toEqual([]);
  }
});

test("токенизация сохраняет JSON, escaped double quotes и filter_complex с внутренними разделителями", () => {
  expect(commandWords(MUSIC_LEVEL_COMMANDS[0])[0]).toContain('--props={"audioMode":"voice-only"}');
  expect(commandWords('npx remotion render src/index.ts Main out/voice-only.wav --props="{\\"audioMode\\":\\"voice-only\\"}"')[0])
    .toContain('--props={"audioMode":"voice-only"}');
  const filters = commandWords(MUSIC_LEVEL_COMMANDS[5]);
  expect(filters).toHaveLength(1);
  expect(filters[0][filters[0].indexOf("-filter_complex") + 1]).toContain("[a];[0:a]atrim=");
  for (const command of ["npx remotion render 'src/index.ts\" Main out/final.mp4", "test -s out/final.mp4 && echo '", 'test -s out/final.mp4 && echo "', "test -s out/final.mp4\\"]) {
    expect(commandWords(command)).toEqual([]);
  }
});

test("native matcher сохраняет корректный JSON props, отвергает непарные оболочки и неэкранированные внутренние кавычки", async () => {
  const h = await history();
  for (const props of ["'{\"audioMode\":\"mix\"}'", '"{\\"audioMode\\":\\"mix\\"}"']) {
    const command = `${finalCommand} --props=${props}`;
    expect(h.bash(command).output).toMatchObject({ exitCode: 0 });
    expect(commandWords(command)[0]).toContain('--props={"audioMode":"mix"}');
  }
  for (const props of ["'{\"audioMode\":\"mix\"}\"", '"{\\"audioMode\\":\\"mix\\"}\'', '"{"audioMode":"mix"}"']) {
    expect(h.bash(`${finalCommand} --props=${props}`).failed).toBe(true);
  }
});
