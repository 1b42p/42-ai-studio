import { readFileSync, existsSync } from "node:fs";
import { expect, test } from "vitest";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import { allMusicStubs } from "./music-eval-support";
import { MUSIC_LEVEL_COMMANDS, MUSIC_SCENES, MUSIC_PROJECT as P, SPEC, project } from "../../../evals/music/fixtures";
import cases from "../../../evals/fixtures/music/history-inputs.json";

// Reviewed outcomes for every requested action, including reads after rejected writes.
// These are expectations, not a second matcher or a simulated filesystem.
const historicalRules = [
  [
    "skill", "skill", "skill", "skill", "skill", "speech-1-explicit", "speech-2-explicit", "speech-3-explicit",
    "unsupported-command", "speech-0-explicit", "reference-7", "reference-4", "reference-6", "journal-read",
    "file-package.json", "file-src/BackgroundMusic.tsx", "file-src/index.ts", "file-src/ducking.ts",
    "file-public/voice/scene-02.words.json", "file-public/voice/scene-01.words.json", "file-public/voice/scene-03.words.json",
    "file-public/voice/scene-04.words.json", "unsupported-command", "skill", "unsupported-command", "file-src/Root.tsx",
    "reference-8", "make-music", "reference-3", "unsupported-command", "reference-2", "source-edit", "journal-replace-unsupported",
    "journal-replace-unsupported", "unsupported-command", "compositions", "unsupported-command", "frame-0", "frame-150", "frame-450",
    "frame-300", "frame-100", "unsupported-command", "frame-599", "file-src/Root.tsx", "journal-read",
    "unsupported-command", "source-edit", "journal-write", "file-src/Root.tsx", "unsupported-command", "journal-read",
    "unsupported-command", "unsupported-command", "unsupported-command", "mix-peak",
  ],
  [
    "skill", "skill", "skill", "unsupported-command", "skill", "skill", "skill", "skill", "journal-read",
    "file-src/Root.tsx", "unsupported-command", "skill", "file-package.json", "unsupported-command", "unsupported-command",
    "speech-3-explicit", "music-invalid", "speech-2-explicit", "speech-1-explicit", "speech-0-explicit",
    "file-public/voice/scene-01.words.json", "file-public/voice/scene-02.words.json", "file-public/voice/scene-03.words.json",
    "reference-3", "reference-2", "reference-6", "file-public/voice/scene-04.words.json", "reference-4", "unsupported-command",
    "same-template-copy", "caption-doc", "caption-doc", "directory-public", "unsupported-command", "journal-write",
    "source-edit", "file-src/Root.tsx", "source-edit", "unsupported-command", "unsupported-command", "frame-100", "frame-0",
    "frame-450", "frame-300", "frame-150", "frame-599", "journal-replace-unsupported", "final-render", "mix-peak", "unsupported-command",
    "unsupported-command", "journal-replace-unsupported",
  ],
  [
    "skill", "skill", "skill", "skill", "skill", "skill", "file-src/Root.tsx", "journal-read", "file-package.json",
    "unsupported-command", "unsupported-command", "file-src/Root.tsx", "unsupported-command", "unsupported-command",
    "unsupported-command", "file-src/BackgroundMusic.tsx", "reference-6", "reference-4", "unsupported-command",
    "unsupported-command", "unsupported-command", "unsupported-command", "find-project", "unsupported-command",
    "file-src/index.ts", "file-src/ducking.ts", "unsupported-command", "isolate-question",
  ],
];
// Retired optional diagnostics fail explicitly to leave room for field-specific
// recorded media operations under eve's 100-rule limit. No file substitution.
const ruleNames: Record<string, string> = {
  "reference-7": "unknown-read", "reference-8": "unknown-read",
  "reference-2": "reference-music-synthesis/templates/ducking.ts",
  "reference-3": "reference-music-synthesis/templates/BackgroundMusic.tsx.template",
  "reference-4": "reference-frame-review/references/notes-template.md",
  "reference-6": "reference-voiceover/references/remotion.md",
  compositions: "unsupported-command", "same-template-copy": "test-source",
  "ls-root": "unsupported-command", "find-project": "unsupported-command",
  "source-edit": "unsupported-edit", "journal-read": "unknown-read",
  "directory-public": "unknown-read", "caption-doc": "isolate-other-pages",
};
historicalRules[0][53] = "probe-selected-default=nw=1";
historicalRules[2][9] = "unsupported-command";

test("все 136 исторических действий проверены native matcher; незаписанная команда не исполняется", async () => {
  let checked = 0;
  for (const scenario of cases.cases) {
    const playback = new StubPlayback(await allMusicStubs());
    for (const action of scenario.actions) {
      checked++;
      if (action.kind === "skill") {
        expect(historicalRules[scenario.index][action.position]).toBe("skill");
        expect(existsSync(`agent/skills/${action.name}/SKILL.md`)).toBe(true);
        continue;
      }
      const result = playback.call({ callId: `history-${scenario.index}-${action.position}`, tool: action.name, input: action.input });
      expect(result.kind, `case ${scenario.index}, action ${action.position}: ${action.name}`).toBe("stub");
      if (result.kind !== "stub") continue;
      const previous = historicalRules[scenario.index][action.position];
      expect(result.ruleId, `case ${scenario.index}, action ${action.position}`).toBe(ruleNames[previous] ?? previous);
      if (["unsupported-command", "source-edit", "journal-read", "journal-replace-unsupported"].includes(result.ruleId)) {
        expect(result.outcome).toHaveProperty("throw");
      }
      if (action.name === "bash" && !["unsupported-command", "music-invalid"].includes(result.ruleId)) {
        expect(result.outcome).toMatchObject({ response: { status: "completed", exitCode: 0 } });
      }
      if (action.name === "read_file" && "response" in result.outcome) {
        const input = action.input as { filePath?: string };
        const output = result.outcome.response as { path: string; content: string };
        expect(output.path.endsWith("Root.tsx") && !input.filePath?.endsWith("Root.tsx")).toBe(false);
      }
      if (action.name === "bash" && String((action.input as { command?: string }).command).includes("--out /workspace/calm-bed/public/music/bg.wav")) {
        expect(result.outcome).toMatchObject({ response: { exitCode: 1 } });
      }
    }
  }
  expect(checked).toBe(136);
  expect(historicalRules.map(rules => rules.length)).toEqual(cases.cases.map(scenario => scenario.actions.length));
});

test("нативная валидация stubs и лимит 100 правил", async () => {
  expect((await allMusicStubs()).length).toBeLessThanOrEqual(100);
});

test("SPEC на диске и при каждом чтении совпадает; шаблоны копируются побайтно", () => {
  expect(readFileSync("evals/fixtures/music/SPEC.md", "utf8")).toBe(SPEC);
  for (const [from, to] of [["ducking.ts", "ducking.ts"], ["BackgroundMusic.tsx.template", "BackgroundMusic.tsx"]]) {
    expect(readFileSync(`agent/skills/music-synthesis/templates/${from}`, "utf8"))
      .toBe((project.files as Record<string, string>)[`src/${to}`]);
  }
});

test("чтения исходников неизменны до/после генерации; журнал никогда не возвращает старый текст", async () => {
  const playback = new StubPlayback(await allMusicStubs());
  const get = (id: string, tool: string, input: unknown) => playback.call({ callId: id, tool, input });
  const first = get("root-first", "read_file", { filePath: `${P}/src/Root.tsx` });
  get("write-denied", "edit_file", { filePath: `${P}/src/Root.tsx`, newString: "different graphics" });
  const last = get("root-last", "read_file", { filePath: `${P}/src/Root.tsx` });
  expect(first.kind).toBe("stub"); expect(last.kind).toBe("stub");
  if (first.kind === "stub" && last.kind === "stub") expect(first.outcome).toEqual(last.outcome);
  get("notes-write", "edit_file", { filePath: `${P}/NOTES.md`, newString: "actual measurements" });
  const notes = get("notes-read", "read_file", { filePath: `${P}/NOTES.md` });
  if (notes.kind === "stub") expect(notes.outcome).toHaveProperty("throw");
  const spec = get("spec", "read_file", { filePath: `${P}/SPEC.md` });
  if (spec.kind === "stub") expect(spec.outcome).toMatchObject({ response: { content: SPEC } });
});

test("документы $HOME возвращают собственный установленный текст, неизвестные — ошибку", async () => {
  const playback = new StubPlayback(await allMusicStubs());
  for (const [index, path] of ["music-synthesis/references/mixing.md", "voiceover/references/remotion.md", "music-synthesis/templates/ducking.ts"].entries()) {
    const result = playback.call({ callId: `doc-${index}`, tool: "read_file", input: { filePath: `$HOME/.agents/skills/${path}` } });
    if (result.kind !== "stub") throw new Error("Unstubbed document");
    expect(result.outcome).toMatchObject({ response: { content: readFileSync(`agent/skills/${path}`, "utf8") } });
  }
  const missing = playback.call({ callId: "missing", tool: "read_file", input: { filePath: "$HOME/.agents/skills/not-a-real-file.md" } });
  if (missing.kind === "stub") expect(missing.outcome).toHaveProperty("throw");
});

test.each([{ voice: "ru-RU-DmitryNeural" }, { rate: 100 }, { rate: -10 }, { language: "en-US" }])("matcher отвергает несовместимый speak %j", async options => {
  const result = new StubPlayback(await allMusicStubs()).call({ callId: "speech", tool: "speak", input: { text: MUSIC_SCENES[0].text, outputPath: `${P}/public/voice/scene-01`, ...options } });
  if (result.kind === "stub") expect(result.outcome).toHaveProperty("throw"); else throw new Error("Unstubbed speech");
});
test.each([{}, { voice: "ru-RU-SvetlanaNeural", rate: 0 }, { language: "ru", rate: 0 }, { voice: "ru-RU-SvetlanaNeural", language: "en-US" }])("matcher принимает эквивалентный speak %j", async options => {
  const result = new StubPlayback(await allMusicStubs()).call({ callId: "speech", tool: "speak", input: { text: MUSIC_SCENES[0].text, outputPath: `${P}/public/voice/scene-01`, ...options } });
  if (result.kind === "stub") expect(result.outcome).toHaveProperty("response"); else throw new Error("Unstubbed speech");
});

test.each(["--out /workspace/calm-bed/public/music/bg.wav", "--seconds 30", "--lufs -24", "--mood upbeat", "--seed 2"])("неподдержанные параметры музыки не получают успех: %s", async changed => {
  let command = `python3 "$HOME/.agents/skills/music-synthesis/scripts/make_music.py" --mood calm --seconds 20 --seed 1 --lufs -18 --out ${P}/public/music/bg`;
  command = command.replace(changed.startsWith("--out") ? /--out \S+/u : changed.startsWith("--seconds") ? /--seconds \S+/u : changed.startsWith("--lufs") ? /--lufs \S+/u : changed.startsWith("--mood") ? /--mood \S+/u : /--seed \S+/u, changed);
  const result = new StubPlayback(await allMusicStubs()).call({ callId: "music", tool: "bash", input: { command } });
  if (result.kind === "stub") expect(result.outcome).toMatchObject({ response: { exitCode: 1 } });
});

test.each([
  "test -s src/Root.tsx && npx remotion render src/index.ts Main out/final.mp4",
  "npx remotion render src/index.ts Main out/final.mp4 && false",
  "stat src/Root.tsx NOTES.md && pwd && ls -la",
  "test -s out/final.mp4 && npx remotion ffprobe -show_streams -of json out/final.mp4",
  "npx remotion render src/index.ts Main out/frames-1 --frames=0,37,150,300,450,599",
  "npx remotion ffprobe -show_entries format=duration -of json out/final.mp4",
  "npx remotion ffprobe -select_streams a:0 -show_streams -show_format -of json out/final.mp4",
  "find /workspace/calm-bed -maxdepth 1 -type f",
  "cp /tmp/changed.tsx /workspace/calm-bed/src/Root.tsx",
  "echo changed > /workspace/calm-bed/src/Root.tsx",
])("составная/неизвестная команда не получает частичный успех: %s", async command => {
  const result = new StubPlayback(await allMusicStubs()).call({ callId: "compound", tool: "bash", input: { command } });
  if (result.kind === "stub") expect(result.outcome).toHaveProperty("throw"); else throw new Error("Real execution escaped");
});

test("канонические раздельные рендеры/замеры действительно попадают в native правила", async () => {
  const playback = new StubPlayback(await allMusicStubs());
  MUSIC_LEVEL_COMMANDS.forEach((command, index) => {
    const result = playback.call({ callId: `canonical-${index}`, tool: "bash", input: { command } });
    if (result.kind !== "stub") throw new Error("Unstubbed command");
    expect(result.ruleId).toBe(["level-0", "level-1", "measure-out/voice-only.wav-full", "measure-out/voice-only.wav-input", "measure-out/music-only.wav-input", "measure-outside"][index]);
    expect(result.outcome).toMatchObject({ response: { exitCode: 0 } });
  });
  expect(project.files["src/Root.tsx"]).toContain("SceneCaptions");
});
