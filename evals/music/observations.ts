import { posix } from "node:path";
import type { EveEvalStreamEvent } from "eve/evals";
import { resolveVoiceChoice } from "../../lib/speech/voices";
import { videoLinks } from "../video/observations";
import { MUSIC_FRAMES, MUSIC_PATH, MUSIC_PROJECT as P, MUSIC_SCENES, VOICE, frameName, musicWordsFile, sceneName } from "./data";
import { isMusicFrameOutput } from "./media-fixture";
import { probesComplete } from "./probe-evidence";

export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export type CompletedCall = { name: string; input: Record<string, unknown>; output: Record<string, unknown>; requested: number; completed: number };
export function completedMusicCalls(events: readonly EveEvalStreamEvent[]): CompletedCall[] {
  const requests = new Map<string, Omit<CompletedCall, "output" | "completed">>();
  const calls: CompletedCall[] = [];
  events.forEach((event, index) => {
    if (event.type === "actions.requested") for (const action of event.data.actions) {
      if (action.kind === "tool-call") requests.set(action.callId, { name: action.toolName, input: action.input, requested: index });
    }
    if (event.type !== "action.result" || event.data.status !== "completed") return;
    const result = event.data.result;
    if (result.kind !== "tool-result" || result.isError || !record(result.output)) return;
    const request = requests.get(result.callId);
    if (!request || request.name !== result.toolName) return;
    if (request.name === "bash" && (result.output.status !== "completed" || result.output.exitCode !== 0)) return;
    calls.push({ ...request, output: result.output, completed: index });
    requests.delete(result.callId);
  });
  return calls;
}

// Consume every character. An unterminated quote/escape invalidates the WHOLE command,
// including any seemingly valid prefix before it. JSON/filter contents remain literal.
function shellWords(command: unknown): string[][] | undefined {
  if (typeof command !== "string") return undefined;
  const groups: string[][] = [[]];
  let quote: "'" | '"' | undefined;
  let token = "";
  let started = false;
  const flush = () => {
    if (started) groups.at(-1)!.push(token);
    token = "";
    started = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      const next = command[++index];
      if (next === undefined) return undefined;
      if (next === "\n") continue;
      token += quote === '"' && !/["\\$`]/u.test(next) ? `\\${next}` : next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/[\s;&|]/u.test(char)) {
      flush();
      if (/[;&|\n]/u.test(char)) groups.push([]);
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) return undefined;
  flush();
  return groups.filter(words => words.length > 0);
}

export function commandWords(command: unknown): string[][] {
  const groups = shellWords(command) ?? [];
  return groups.filter(words => /^(?:npx|remotion|python3?|ffmpeg|ffprobe|test|stat|wc|ls|cp)$/u.test(posix.basename(words[0] ?? "")));
}
const option = (words: string[], key: string) => words.find(word => word.startsWith(`${key}=`))?.slice(key.length + 1) ?? (words.includes(key) ? words[words.indexOf(key) + 1] : undefined);
const projectPath = (path: string) => posix.resolve(path.startsWith("calm-bed/") ? "/workspace" : P, path);
const toolPath = (path: unknown) => typeof path === "string" ? posix.resolve("/workspace", path) : undefined;
const text = (call: CompletedCall) => [call.output.stdout, call.output.stderr].filter(v => typeof v === "string").join("\n");
const journalPath = (content: string, path: string) => {
  const alternatives = [path, posix.relative(P, path)].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}_./-])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_/-])`, "u").test(content);
};

function preservesSources(call: CompletedCall): boolean {
  if (call.name === "edit_file") return toolPath(call.input.filePath) === `${P}/NOTES.md`;
  if (call.name !== "bash") return true;
  const command = String(call.input.command);
  if (!shellWords(command)) return false;
  if (/[>`]/u.test(command) || /\b(?:sed|perl|rm|mv|tee|truncate|touch|node|eval|exec|echo|printf)\b/u.test(command)) return false;
  const groups = commandWords(command);
  const commands = shellWords(command)!;
  const last = commands.at(-1);
  if ((commands.length === 1 || (commands.length === 2 && commands[0].join(" ") === `cd ${P}`)) &&
    last?.length === 3 && last[0] === "mkdir" && last[1] === "-p" && projectPath(last[2]) === `${P}/out`) return true;
  for (const words of groups) {
    if (words[0] === "cp") {
      if (words.length !== 3) return false;
      const source = words[1].replace(/^\$HOME/u, "/root");
      const target = projectPath(words[2]);
      if (![["ducking.ts", "ducking.ts"], ["BackgroundMusic.tsx.template", "BackgroundMusic.tsx"]]
        .some(([from, to]) => source === `/root/.agents/skills/music-synthesis/templates/${from}` && target === `${P}/src/${to}`)) return false;
    }
    if (/^python3?$/u.test(words[0]) && !/\/\.agents\/skills\/(?:music-synthesis\/scripts\/make_music|frame-review\/scripts\/check-frames)\.py$/u.test(words[1] ?? "")) return false;
  }
  return /^(?:\s*cd\s+["']?\/workspace\/calm-bed["']?\s*&&)?\s*(?:(?:npx\s+)?remotion\b|python3?\s|cp\s|pwd\b|ls\b|find\b|rg\b|cat\b|test\b|stat\b)/u.test(command);
}

export function matchingMusicSpeech(input: Record<string, unknown>): boolean {
  if (input.rate !== undefined && input.rate !== 0 || input.voice !== undefined && typeof input.voice !== "string" || input.language !== undefined && typeof input.language !== "string") return false;
  const voice = resolveVoiceChoice({ voice: input.voice as string | undefined, language: typeof input.language === "string" ? input.language : "ru-RU" }, []);
  return voice.ok && voice.choice.voice === VOICE && voice.choice.language === "ru-RU";
}

function musicCall(call: CompletedCall): boolean {
  if (call.name !== "bash") return false;
  const words = commandWords(call.input.command).find(words => /^python3?$/u.test(posix.basename(words[0])) && words[1]?.endsWith("/make_music.py"));
  if (!words || option(words, "--mood") !== "calm" || Number(option(words, "--seconds")) !== 20 ||
    Number(option(words, "--seed") ?? 1) !== 1 || Number(option(words, "--lufs") ?? -18) !== -18 ||
    Number(option(words, "--bpm") ?? 80) !== 80 || projectPath(option(words, "--out") ?? "") !== `${P}/public/music/bg`) return false;
  try {
    const data: unknown = JSON.parse(String(call.output.stdout));
    return record(data) && data.audioPath === MUSIC_PATH && data.durationMs === 20000 && data.mood === "calm" && data.seed === 1 && data.bpm === 80 && data.integratedLufs === -18;
  } catch { return false; }
}

function renderInfo(call: CompletedCall) {
  if (call.name !== "bash" || !text(call).includes("Rendered")) return undefined;
  for (const words of commandWords(call.input.command)) {
    const at = words.findIndex(word => posix.basename(word) === "remotion");
    if (at < 0 || words[at + 1] !== "render" || projectPath(words[at + 2] ?? "") !== `${P}/src/index.ts` || words[at + 3] !== "Main") continue;
    try {
      const props: unknown = JSON.parse(option(words, "--props") ?? "{}");
      if (!record(props) || Object.keys(props).some(key => key !== "audioMode")) continue;
      const mode = props.audioMode ?? "mix";
      if (!["mix", "voice-only", "music-only"].includes(String(mode)) || words.some(word => /^--(?:duration|muted|scale)(?:=|$)/u.test(word))) continue;
      return { call, path: projectPath(option(words, "--output") ?? words[at + 4] ?? ""), mode: String(mode), frames: option(words, "--frames") };
    } catch { continue; }
  }
}

type RequestedCall = Pick<CompletedCall, "name" | "input" | "requested">;

function pendingMusicCalls(events: readonly EveEvalStreamEvent[]): RequestedCall[] {
  const pending = new Map<string, RequestedCall>();
  events.forEach((event, index) => {
    if (event.type === "actions.requested") for (const action of event.data.actions) {
      if (action.kind === "tool-call") pending.set(action.callId, {
        name: action.toolName, input: action.input, requested: index,
      });
    }
    // A returned bash job may still be writing, even though its tool call settled.
    if (event.type === "action.result" && "callId" in event.data.result) {
      const result = event.data.result;
      const request = pending.get(result.callId);
      const running = request?.name === "bash" && event.data.status === "completed" &&
        result.kind === "tool-result" && !result.isError && record(result.output) && result.output.status === "running";
      if (!running) pending.delete(result.callId);
    }
  });
  return [...pending.values()];
}

function musicOutput(call: CompletedCall | RequestedCall): Record<string, unknown> | undefined {
  if (!("output" in call)) return undefined;
  try {
    const value: unknown = JSON.parse(String(call.output.stdout));
    return record(value) ? value : undefined;
  } catch { return undefined; }
}

// Identify writes BEFORE validating their parameters. A successful but wrong-mode,
// wrong-voice or wrong-duration overwrite must not leave an older proof usable.
function artifactKeys(call: CompletedCall | RequestedCall): string[] {
  if (call.name === "speak") {
    const output = "output" in call ? call.output : {};
    return MUSIC_SCENES.flatMap((_, index) => {
      const base = `${P}/public/voice/${sceneName(index)}`;
      return toolPath(call.input.outputPath) === base || output.audioPath === `${base}.mp3` || output.timingsPath === `${base}.words.json`
        ? [`voice:${index}`] : [];
    });
  }
  if (call.name === "edit_file") return toolPath(call.input.filePath) === `${P}/NOTES.md` ? ["journal"] : [];
  if (call.name !== "bash") return [];
  const keys: string[] = [];
  for (const words of commandWords(call.input.command)) {
    if (/^python3?$/u.test(posix.basename(words[0])) && words[1]?.endsWith("/make_music.py")) {
      const out = option(words, "--out");
      if ((out && projectPath(`${out}.wav`) === MUSIC_PATH) || musicOutput(call)?.audioPath === MUSIC_PATH) keys.push("music");
    }
    const at = words.findIndex(word => posix.basename(word) === "remotion");
    if (at < 0 || words[at + 1] !== "render") continue;
    const target = projectPath(option(words, "--output") ?? words[at + 4] ?? "");
    keys.push(`file:${target}`);
    if (target === `${P}/out/frames-1` || target.startsWith(`${P}/out/frames-1/`)) keys.push("frames");
    try {
      const props: unknown = JSON.parse(option(words, "--props") ?? "{}");
      if (record(props) && ["voice-only", "music-only"].includes(String(props.audioMode))) keys.push(`mode:${props.audioMode}`);
    } catch { /* The target still counts as overwritten when props are invalid. */ }
  }
  return keys;
}

function artifactVersions(events: readonly EveEvalStreamEvent[], calls: CompletedCall[]) {
  const writes = [
    ...calls.map(call => ({ result: call, keys: artifactKeys(call) })),
    ...pendingMusicCalls(events).map(call => ({ result: undefined, keys: artifactKeys(call) })),
  ].filter(write => write.keys.length > 0);
  return (key: string): CompletedCall | undefined => {
    const writers = writes.filter(write => write.keys.includes(key));
    if (writers.some(write => !write.result)) return undefined;
    const latest = writers.reduce<CompletedCall | undefined>((last, write) =>
      !last || write.result!.completed > last.completed ? write.result : last, undefined);
    // Completion order cannot establish which overlapping writer last touched a file.
    // Require a causally later rewrite, not just checks after both returned.
    if (!latest || writers.some(write => write.result !== latest && write.result!.completed >= latest.requested)) return undefined;
    return latest;
  };
}

type Track = { mode: string; path: string; requested: number; completed: number; command: string };
type Level = { mode: string; path: string; windows: { start: number; end: number }[]; lufs: number; requested: number; completed: number; command: string };
function measure(call: CompletedCall, tracks: Track[]): Level | undefined {
  const numbers = [...text(call).matchAll(/"input_i"\s*:\s*"?(-?[\d.]+)/gu)].map(match => Number(match[1]));
  if (!numbers.length || numbers.some(number => !Number.isFinite(number) || number !== numbers[0])) return undefined;
  for (const words of commandWords(call.input.command)) {
    if (!words.some(word => posix.basename(word) === "ffmpeg") || !words.includes("-vn") || words.filter(word => word === "-i").length !== 1) continue;
    const path = projectPath(option(words, "-i") ?? "");
    const track = tracks.findLast(track => track.path === path && track.completed < call.requested);
    const filter = option(words, "-af") ?? option(words, "-filter:a") ?? option(words, "-filter_complex");
    if (!track || !filter?.includes("loudnorm=")) continue;
    const filters = [...filter.matchAll(/(?:^|[,;]|\])\s*([a-z][a-z0-9_]*)\s*(?:=|,|$)/gu)].map(match => match[1]);
    if (filters.some(name => !["atrim", "asetpts", "concat", "loudnorm"].includes(name)) || /\[[1-9]\d*:/u.test(filter)) continue;
    const windows = [...filter.matchAll(/atrim=(?:start=)?([\d.]+):(?:end=)?([\d.]+)/gu)].map(match => ({ start: Number(match[1]), end: Number(match[2]) }));
    if ((filter.match(/\batrim\b/gu) ?? []).length !== windows.length) continue;
    const ss = option(words, "-ss"), duration = option(words, "-t"), to = option(words, "-to");
    // Output trimming does not constrain the samples analyzed by loudnorm.
    // It is recorded diagnostics, never proof of an input speech window.
    const inputAt = words.indexOf("-i");
    if (["-ss", "-t", "-to"].some(flag => words.includes(flag) && words.indexOf(flag) > inputAt)) continue;
    if (windows.length && (ss !== undefined || duration !== undefined || to !== undefined)) continue;
    if (ss !== undefined || duration !== undefined || to !== undefined) windows.push({ start: Number(ss ?? 0), end: to === undefined ? Number(ss ?? 0) + Number(duration) : Number(to) });
    if (windows.some(window => !Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start < 0 || window.end > 20 || window.end <= window.start)) continue;
    if (windows.length > 1 && (!filter.includes(`concat=n=${windows.length}:v=0:a=1`) || !filter.includes("asetpts=PTS-STARTPTS"))) continue;
    return { mode: track.mode, path, windows, lufs: numbers[0], requested: call.requested, completed: call.completed, command: String(call.input.command) };
  }
}

export function musicLevelEvidence(events: readonly EveEvalStreamEvent[], after = -1) {
  const calls = completedMusicCalls(events);
  const latest = artifactVersions(events, calls);
  const tracks = calls.flatMap(call => {
    const render = renderInfo(call);
    return render && render.frames === undefined && render.mode !== "mix" && /\.(?:wav|mp4)$/u.test(render.path) && render.path !== `${P}/out/final.mp4` && call.requested > after &&
      latest(`file:${render.path}`) === call && latest(`mode:${render.mode}`) === call
      ? [{ mode: render.mode, path: render.path, requested: call.requested, completed: call.completed, command: String(call.input.command) }] : [];
  });
  const levels = calls.flatMap(call => { const level = call.name === "bash" ? measure(call, tracks) : undefined; return level ? [level] : []; });
  return { tracks, levels };
}

function levelProof(levels: Level[]) {
  const speech = MUSIC_SCENES.flatMap((scene, index) => scene.sentences.map(span => ({ start: (index * 150 + 10) / 30 + span.startMs / 1000, end: (index * 150 + 10) / 30 + span.endMs / 1000 })));
  const inside = (level: Level) => level.windows.length === 1 && level.windows[0].end - level.windows[0].start >= 0.4 && speech.some(span => level.windows[0].start >= Math.max(1, span.start) && level.windows[0].end <= span.end);
  const full = levels.find(level => level.mode === "voice-only" && !level.windows.length && Math.abs(level.lufs + 16) <= 2);
  const voices = levels.filter(level => level.mode === "voice-only" && inside(level) && Math.abs(level.lufs + 16) <= 2);
  const music = levels.find(level => level.mode === "music-only" && inside(level) && voices.some(voice => voice.path !== level.path && voice.windows[0].start === level.windows[0].start && voice.windows[0].end === level.windows[0].end && voice.lufs - level.lufs >= 8));
  const voice = music && voices.find(voice => voice.path !== music.path && voice.windows[0].start === music.windows[0].start && voice.windows[0].end === music.windows[0].end && voice.lufs - music.lufs >= 8);
  const outside = levels.find(level => level.mode === "music-only" && Math.abs(level.lufs + 18) <= 2 && level.windows.length > 0 && level.windows.reduce((sum, w) => sum + w.end - w.start, 0) >= 0.4 && level.windows.every((window, index) => window.start >= 1 && window.end <= 18 && (index === 0 || window.start >= level.windows[index - 1].end) && speech.every(span => window.end <= span.start - 0.2 || window.start >= span.end + 0.4)));
  return full && music && voice && outside ? { levels: [full, voice, music, outside], completed: Math.max(full.completed, music.completed, voice.completed, outside.completed) } : undefined;
}
export const musicLevelsCompleted = (events: readonly EveEvalStreamEvent[]) => !!levelProof(musicLevelEvidence(events).levels);

function pixelsChecked(call: CompletedCall): boolean {
  if (call.name !== "bash" || !String(call.input.command).includes("check-frames.py") || typeof call.output.stdout !== "string") return false;
  const rows: Record<string, unknown>[] = [];
  try {
    for (const line of call.output.stdout.split("\n")) if (line.startsWith("{")) {
      const row: unknown = JSON.parse(line);
      if (!record(row)) return false;
      rows.push(row);
    }
  } catch { return false; }
  return rows.length === MUSIC_FRAMES.length && MUSIC_FRAMES.every(frame => {
    const matching = rows.filter(row => typeof row.path === "string" && projectPath(row.path) === `${P}/out/frames-1/${frameName(frame)}`);
    if (matching.length !== 1) return false;
    const row = matching[0];
    if (row.suspect !== null || row.error !== undefined || !Array.isArray(row.extrema) || row.extrema.length !== 3) return false;
    return row.extrema.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(value => Number.isInteger(value) && value >= 0 && value <= 255) && pair[1] >= pair[0]) &&
      row.extrema.some(pair => pair[1] - pair[0] > 2) && row.extrema.some(pair => pair[1] > 8);
  });
}

export function musicWorkflowGates(events: readonly EveEvalStreamEvent[]) {
  const calls = completedMusicCalls(events);
  const latest = artifactVersions(events, calls);
  const musicWrite = latest("music");
  const music = musicWrite && musicCall(musicWrite) ? musicWrite : undefined;
  const voices = MUSIC_SCENES.map((scene, index) => {
    const call = latest(`voice:${index}`);
    return call && call.name === "speak" && matchingMusicSpeech(call.input) &&
      call.input.text === scene.text && call.output.text === scene.text &&
      call.output.voice === VOICE && call.output.durationMs === scene.durationMs &&
      toolPath(call.input.outputPath) === `${P}/public/voice/${sceneName(index)}` &&
      call.output.audioPath === `${P}/public/voice/${sceneName(index)}.mp3` &&
      call.output.timingsPath === `${P}/public/voice/${sceneName(index)}.words.json` ? call : undefined;
  });
  const timings = voices.map((voice, index) => voice && calls.find(call => call.name === "read_file" && toolPath(call.input.filePath) === `${P}/public/voice/${sceneName(index)}.words.json` && call.output.content === musicWordsFile(index) && call.requested > voice.completed));
  const generated = !!music && voices.every(Boolean), timed = generated && timings.every(Boolean);
  const ready = timed ? Math.max(music!.completed, ...timings.map(call => call!.completed)) : Infinity;
  const intact = calls.every(preservesSources);
  const skillAt = events.findIndex(event => event.type === "action.result" && event.data.status === "completed" && event.data.result.kind === "load-skill-result" && event.data.result.name === "frame-review");
  const frameWrite = latest("frames");
  const frameRender = frameWrite && renderInfo(frameWrite);
  const rendered = frameWrite && frameRender?.frames === MUSIC_FRAMES.join(",") &&
    frameRender.path === `${P}/out/frames-1` && frameWrite.requested > Math.max(ready, skillAt) ? frameWrite : undefined;
  const pixels = rendered && calls.find(call => call.requested > rendered.completed && pixelsChecked(call));
  const viewed = pixels ? MUSIC_FRAMES.map(frame => calls.find(call => call.name === "read_file" && toolPath(call.input.filePath) === `${P}/out/frames-1/${frameName(frame)}` && isMusicFrameOutput(call.output) && call.requested > pixels.completed)) : [];
  const frames = skillAt >= 0 && viewed.length === 6 && viewed.every(Boolean);
  const frameReady = frames ? Math.max(...viewed.map(call => call!.completed)) : Infinity;
  const evidence = musicLevelEvidence(events, frameReady);
  const proof = levelProof(evidence.levels);
  const levelsReady = proof?.completed ?? -1;
  const journalWrite = latest("journal");
  const journal = levelsReady >= 0 && !!journalWrite && ((call: CompletedCall) => {
    if (call.name !== "edit_file" || toolPath(call.input.filePath) !== `${P}/NOTES.md` || call.requested <= levelsReady || typeof call.input.newString !== "string") return false;
    const content = call.input.newString.replaceAll("−", "-");
    const numericText = content.replace(/(?<=\d)[-–—](?=\d)/gu, " ");
    const values = (numericText.match(/-?\d+(?:[.,]\d+)?/gu) ?? []).map(value => Number(value.replace(",", ".")));
    return !!proof && proof.levels.every(level => journalPath(content, level.path) &&
      values.some(value => Math.abs(value - level.lufs) <= 0.11) && level.windows.every(window =>
        values.some(value => Math.abs(value - window.start) < 0.001) && values.some(value => Math.abs(value - window.end) < 0.001)));
  })(journalWrite);
  const finalWrite = latest(`file:${P}/out/final.mp4`);
  const finalRender = finalWrite && renderInfo(finalWrite);
  const final = levelsReady >= 0 && finalWrite && finalRender?.path === `${P}/out/final.mp4` &&
    finalRender.mode === "mix" && finalRender.frames === undefined && finalWrite.requested > levelsReady ? finalWrite : undefined;
  const afterFinal = final ? calls.filter(call => call.requested > final.completed && commandWords(call.input.command).some(words => words.some(word => projectPath(word) === `${P}/out/final.mp4`))) : [];
  const size = afterFinal.some(call => commandWords(call.input.command).some(words => words[0] === "test" && words.includes("-s") || words[0] === "stat" && /\b[1-9]\d{3,}\b/u.test(text(call))));
  const probe = probesComplete(afterFinal.flatMap(call => commandWords(call.input.command)
    .filter(words => words.some(word => posix.basename(word) === "ffprobe"))
    .map(words => ({ words, stdout: String(call.output.stdout ?? "") }))));
  const peak = afterFinal.some(call => {
    if (!String(call.input.command).includes("loudnorm=") || !commandWords(call.input.command).some(words => words.includes("-vn") && words.some(word => posix.basename(word) === "ffmpeg"))) return false;
    if (commandWords(call.input.command).some(words => words.some(word => ["-ss", "-t", "-to", "-filter_complex"].includes(word)))) return false;
    if (!commandWords(call.input.command).some(words => (option(words, "-af") ?? option(words, "-filter:a")) === "loudnorm=print_format=json")) return false;
    const peaks = [...text(call).matchAll(/"input_tp"\s*:\s*"?(-?[\d.]+)/gu)].map(match => Number(match[1]));
    return peaks.length > 0 && peaks.every(peak => Number.isFinite(peak) && peak <= -1);
  });
  return { generation: generated, timings: timed, immutableSources: intact, frames, isolatedRenders: evidence.tracks.some(t => t.mode === "voice-only") && evidence.tracks.some(t => t.mode === "music-only"), separateLevels: levelsReady >= 0, journal, finalMixRender: !!final, fileSize: size, probe, peak };
}
export const musicWorkflowCompleted = (events: readonly EveEvalStreamEvent[]) => Object.values(musicWorkflowGates(events)).every(Boolean);
export const musicFinalLink = (message: string | undefined) => videoLinks(message).includes(`${P}/out/final.mp4`);
