import type { EveEvalContext, EveEvalStreamEvent, ToolStub } from "eve/evals";
import { readFileSync } from "node:fs";
import { parseToolStubs } from "../../../node_modules/eve/dist/src/tool-stubs/rules.js";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import { musicSession, MUSIC_PROJECT as P, MUSIC_SCENES, MUSIC_FRAMES, MUSIC_LEVEL_COMMANDS, frameName, sceneName } from "../../../evals/music/fixtures";
import audit from "../../../evals/fixtures/music/integration.json";

export async function allMusicStubs(): Promise<readonly ToolStub[]> {
  let stubs: readonly ToolStub[] = [];
  await musicSession({ target: { async fetch() { return Response.json({ tools: { static: [{ name: "read_page" }, { name: "web_search" }] } }); } },
    session(options: { stubs: readonly ToolStub[] }) { stubs = options.stubs; },
  } as unknown as EveEvalContext);
  return parseToolStubs(stubs);
}
export const event = (type: string, data: unknown) => ({ type, data } as EveEvalStreamEvent);
export async function history() {
  const playback = new StubPlayback(await allMusicStubs());
  const events: EveEvalStreamEvent[] = [];
  let sequence = 0;
  function call(name: string, input: Record<string, unknown>) {
    const callId = `call-${sequence++}`;
    const requested = events.length;
    events.push(event("actions.requested", { actions: [{ kind: "tool-call", callId, toolName: name, input }] }));
    const answer = playback.call({ callId, tool: name, input });
    if (answer.kind !== "stub") throw new Error(`Not stubbed: ${name} ${JSON.stringify(input)}`);
    const failed = "throw" in answer.outcome;
    const output = failed ? answer.outcome.throw!.message : answer.outcome.response;
    events.push(event("action.result", { status: failed ? "failed" : "completed", result: { kind: "tool-result", callId, toolName: name, output } }));
    return { callId, requested, completed: events.length - 1, ruleId: answer.ruleId, failed, output };
  }
  const bash = (command: string) => call("bash", { command });
  function prepare() {
    for (const name of ["voiceover", "music-synthesis", "frame-review"]) {
      events.push(event("action.result", { status: "completed", result: { kind: "load-skill-result", callId: `skill-${name}`, name, output: readFileSync(`agent/skills/${name}/SKILL.md`, "utf8") } }));
    }
    call("read_file", { filePath: `${P}/SPEC.md` });
    MUSIC_SCENES.forEach((scene, index) => {
      call("speak", { text: scene.text, voice: "ru-RU-SvetlanaNeural", rate: 0, outputPath: `${P}/public/voice/${sceneName(index)}` });
      call("read_file", { filePath: `${P}/public/voice/${sceneName(index)}.words.json` });
    });
    bash(`python3 "$HOME/.agents/skills/music-synthesis/scripts/make_music.py" --mood calm --seconds 20 --seed 1 --lufs -18 --out ${P}/public/music/bg`);
  }
  function frames() {
    bash("npx remotion render src/index.ts Main out/frames-1 --frames=0,100,150,300,450,599 --image-format=jpeg --jpeg-quality=90");
    bash('python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/frames-1/*.jpeg');
    MUSIC_FRAMES.forEach(frame => call("read_file", { filePath: `${P}/out/frames-1/${frameName(frame)}` }));
  }
  function levels() { MUSIC_LEVEL_COMMANDS.forEach(command => bash(command)); }
  function journal() { call("edit_file", { filePath: `${P}/NOTES.md`, newString: `out/voice-only.wav out/music-only.wav\nОкна 1–3 с; 4.91–5.12, 9.91–10.12, 14.91–15.12 с.\n${JSON.stringify(audit.measurements)}` }); }
  function render() { bash("npx remotion render src/index.ts Main out/final.mp4"); }
  function checks() {
    bash("stat -c %s out/final.mp4");
    bash("npx remotion ffprobe -show_streams -show_format -of json out/final.mp4");
    bash("npx remotion ffmpeg -i out/final.mp4 -vn -af loudnorm=print_format=json -f null -");
  }
  function complete() { prepare(); frames(); levels(); journal(); render(); checks(); }
  return { events, call, bash, prepare, frames, levels, journal, render, checks, complete };
}
