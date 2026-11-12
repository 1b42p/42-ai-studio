import { MUSIC_PROJECT } from "./data";

export const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const quote = (pattern: string) => {
  const grouped = `(?:${pattern})`;
  return `(?:${grouped}|"${grouped}"|'${grouped}')`;
};
export const pathArg = (path: string) => quote(`(?:${esc(MUSIC_PROJECT)}/)?${esc(path)}`);
export const atomic = (body: string) => `^(?![\\s\\S]*[\\r\\n])[ \\t]*(?:cd[ \\t]+${quote(esc(MUSIC_PROJECT))}[ \\t]*&&[ \\t]*)?${body}[ \\t]*$`;
export const remotion = "(?:npx\\s+)?remotion\\s+";

export const pixelInvocation = `python3?\\s+(?:${quote(esc("/root/.agents/skills/frame-review/scripts/check-frames.py"))}|${esc("$HOME/.agents/skills/frame-review/scripts/check-frames.py")}|"${esc("$HOME/.agents/skills/frame-review/scripts/check-frames.py")}")`;

// Every branch has one fixed stdout: an exact ordered list, or the shell glob
// expanding to that same list. No captures or runtime response interpolation.
export function pixelPattern(paths: string[], globDirectory?: string): string {
  const list = paths.map(path => quote(esc(path))).join("\\s+");
  const inputs = globDirectory ? `(?:${list}|${quote(esc(globDirectory))}/\\*\\.jpeg)` : list;
  return atomic(`${pixelInvocation}\\s+${inputs}`);
}

// Small fixed option groups, NOT arbitrary shell evaluation. Each option occurs
// exactly once; input and output option groups are never shuffled together.
export function optionOrders(options: string[]): string {
  if (options.length === 0) return "";
  return `(?:${options.map((item, index) => `${item}${options.length > 1 ? `\\s+${optionOrders(options.filter((_, at) => at !== index))}` : ""}`).join("|")})`;
}

function fields(pattern: string): string {
  const names = pattern.split(",");
  const members = `(?:${names.map(esc).join("|")})`;
  return names.map(name => `(?=(?:[a-z_]+,)*${esc(name)}(?:,|(?=[:\\s'\"]|$)))`).join("") +
    `${members}(?:,${members}){${names.length - 1}}`;
}

export function entriesPattern(entries: string): string {
  const sections = entries.split(":").map(section => {
    const [name, values] = section.split("=");
    return `${esc(name)}=${fields(values)}`;
  });
  return quote(sections.length === 2 ? `(?:${sections.join(":")}|${sections.toReversed().join(":")})` : sections[0]);
}

export function probePattern(profile: {
  files: string[]; entries: string | null; format: string | null; select?: string | null; full: boolean; quiet: boolean;
}): string {
  const options: string[] = [];
  if (profile.quiet) options.push(`-(?:v|loglevel)\\s+${quote("error")}`);
  if (profile.select) options.push(`-select_streams\\s+${quote(esc(profile.select))}`);
  if (profile.full) options.push("-show_streams", "-show_format");
  if (profile.entries) options.push(`-show_entries\\s+${entriesPattern(profile.entries)}`);
  if (profile.format) {
    const format = esc(profile.format).replace("nw=", "(?:nw|noprint_wrappers)=").replace("p=", "(?:p|print_section)=");
    options.push(`-(?:of|print_format|output_format)\\s+${quote(format)}`);
  }
  // Full/human output includes the input filename. Only field-specific quiet
  // projections can share an identical recording across absolute path aliases.
  const prefix = profile.entries && profile.quiet ? `(?:${esc(MUSIC_PROJECT)}/)?` : "";
  const file = quote(`${prefix}(?:${profile.files.map(esc).join("|")})`);
  const order = optionOrders(options);
  return atomic(`${remotion}ffprobe\\s+${order ? `(?:${order}\\s+${file}|${file}\\s+${order})` : file}`);
}

export function levelPattern(file: string, scope: string, filter = "loudnorm=print_format=json"): string {
  const window = [`-ss\\s+${quote("1(?:\\.0+)?")}`, `-t\\s+${quote("2(?:\\.0+)?")}`];
  const filterArg = filter.includes(";") ? `(?:"${esc(filter)}"|'${esc(filter)}')` : quote(esc(filter));
  const output = ["-vn", `${filter.includes(";") ? "-filter_complex" : "-(?:af|filter:a)"}\\s+${filterArg}`, `-f\\s+${quote("null")}`];
  if (scope === "output") output.push(...window);
  return atomic(`${remotion}ffmpeg\\s+(?:-hide_banner\\s+)?${scope === "input" ? `${optionOrders(window)}\\s+` : ""}-i\\s+${pathArg(file)}\\s+${optionOrders(output)}\\s+${quote("-|/dev/null")}`);
}
