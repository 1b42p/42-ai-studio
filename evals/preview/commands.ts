import { entriesPattern, esc, optionOrders, quote } from "../music/operation-patterns";

export const PROJECT = "/workspace/preview-coffee";
export const projectPath = (seconds: number) => `${PROJECT}-${seconds}`;
export const frameNumbers = (seconds: number) => [0, seconds * 5, seconds * 10, seconds * 15, seconds * 20, seconds * 30 - 1];
export const frameName = (frame: number) => `element-${String(frame).padStart(4, "0")}.jpeg`;
export const pathArg = (path: string, seconds: number) => quote(`(?:${esc(projectPath(seconds))}/)?${esc(path)}`);
export const atomic = (body: string, seconds: number) => `^(?![\\s\\S]*[\\r\\n])[ \\t]*(?:cd[ \\t]+${quote(esc(projectPath(seconds)))}[ \\t]*&&[ \\t]*)?${body}[ \\t]*$`;
const cli = "(?:npx\\s+)?remotion\\s+";
const props = (seconds: number) => `--props(?:=|\\s+)${pathArg(`props-${seconds}.json`, seconds)}`;
const runtime = ["--concurrency(?:=|\\s+)[12]", "--log(?:=|\\s+)error", "--overwrite"];
function options(required: string[], optional: string[] = []) {
  // A bounded CLI grammar: fixed flags, no pipes, substitutions or shell execution.
  const flags = [...required, ...optional];
  const present = required.map(flag => `(?=(?:[^\\r\\n]*\\s)?${flag}(?:\\s|$))`).join("");
  const unique = flags.map(flag => flag.match(/^--[a-z0-9-]+/)![0]).map(name => `(?![^\\r\\n]*${name}(?:=|\\s)[^\\r\\n]*${name}(?:=|\\s))`).join("");
  return `${present}${unique}(?:${flags.join("|")})(?:\\s+(?:${flags.join("|")}))*`;
}
export function videoPattern(seconds: number, draft = false) {
  const draftOptions = ["--scale(?:=|\\s+)0\\.5", "--x264-preset(?:=|\\s+)superfast", "--crf(?:=|\\s+)32"];
  return atomic(`${cli}render\\s+${pathArg("src/index.tsx", seconds)}\\s+Main\\s+${pathArg(draft ? "out/draft.mp4" : "out/final.mp4", seconds)}\\s+${options([props(seconds), ...(draft ? draftOptions : [])], ["--codec(?:=|\\s+)h264", ...runtime])}`, seconds);
}
export function framesPattern(seconds: number) {
  return atomic(`${cli}render\\s+${pathArg("src/index.tsx", seconds)}\\s+Main\\s+${pathArg("out/frames-1", seconds)}\\s+${options([props(seconds), `--frames(?:=|\\s+)${frameNumbers(seconds).join(",")}`, "--image-format(?:=|\\s+)jpeg", "--jpeg-quality(?:=|\\s+)90"])}`, seconds);
}
export function stillPattern(seconds: number, frame: number, destination: string) {
  return atomic(`${cli}still\\s+${pathArg("src/index.tsx", seconds)}\\s+Main\\s+${pathArg(destination, seconds)}\\s+${options([props(seconds), `--frame(?:=|\\s+)${frame}`, "--image-format(?:=|\\s+)jpeg", "--jpeg-quality(?:=|\\s+)85", "--scale(?:=|\\s+)0\\.5"])}`, seconds);
}
export function pixelPattern(paths: string[], seconds: number, glob = false) {
  const script = quote("(?:\\$HOME|/root)/\\.agents/skills/frame-review/scripts/check-frames\\.py");
  const inputs = paths.map(path => pathArg(path, seconds)).join("\\s+");
  return atomic(`python3?\\s+${script}\\s+(?:${inputs}${glob ? `|${pathArg("out/frames-1", seconds)}\\/\\*\\.jpeg` : ""})`, seconds);
}
export const matchesCommand = (pattern: string, command: unknown) => typeof command === "string" && new RegExp(pattern).test(command);
export function probePattern(seconds: number, draft = false, format: "json" | "selected-default" = "json") {
  const fields = format === "json"
    ? ["-show_streams", "-show_format", `-(?:of|print_format)\\s+${quote("json")}`]
    : [`-show_entries\\s+${entriesPattern("stream=codec_name,codec_type,width,height,duration:format=duration")}`, `-(?:of|print_format)\\s+${quote("default=(?:nw|noprint_wrappers)=1")}`];
  const flags = optionOrders(["-(?:v|loglevel)\\s+error", ...fields]);
  return atomic(`(?:${cli})?ffprobe\\s+${flags}\\s+${pathArg(draft ? "out/draft.mp4" : "out/final.mp4", seconds)}`, seconds);
}
export function sizePattern(seconds: number, draft = false) {
  return atomic(`stat\\s+-c\\s+${quote("%s")}\\s+${pathArg(draft ? "out/draft.mp4" : "out/final.mp4", seconds)}`, seconds);
}
export function nonemptyPattern(seconds: number, draft = false) {
  return atomic(`test\\s+-s\\s+${pathArg(draft ? "out/draft.mp4" : "out/final.mp4", seconds)}`, seconds);
}
export function videoLinkPattern(seconds: number, draft = false): RegExp {
  const project = esc(projectPath(seconds).slice("/workspace/".length));
  return new RegExp(`\\]\\((?:/workspace/)?${project}/out/${draft ? "draft" : "final"}\\.mp4\\)`);
}
