type Values = Record<string, unknown>;
type Facts = { streams: Values[]; format: Values };
const record = (value: unknown): value is Values => typeof value === "object" && value !== null && !Array.isArray(value);
const argument = (words: string[], key: string) => words[words.indexOf(key) + 1];
const order = ["index", "codec_name", "codec_type", "width", "height", "duration"];

function projection(words: string[]) {
  const entries = words.includes("-show_entries") ? argument(words, "-show_entries") : "";
  const sections = new Map(entries.split(":").filter(Boolean).map(section => {
    const [name, fields] = section.split("=");
    return [name, fields?.split(",") ?? order];
  }));
  const stream = words.includes("-show_streams") ? order : sections.get("stream") ?? [];
  return { stream: order.filter(field => stream.includes(field)), format: words.includes("-show_format") || sections.has("format") };
}

function parse(words: string[], stdout: string): Facts | undefined {
  const format = ["-of", "-print_format", "-output_format"].find(flag => words.includes(flag));
  const writer = format ? argument(words, format) : "default";
  const selected = projection(words);
  // Human stderr is useful diagnostics, but is not independent per-stream timing.
  if (!selected.stream.length && !selected.format) return undefined;
  if (writer === "json") {
    try {
      const data: unknown = JSON.parse(stdout);
      if (!record(data)) return undefined;
      return { streams: Array.isArray(data.streams) ? data.streams.filter(record) : [], format: record(data.format) ? data.format : {} };
    } catch { return undefined; }
  }
  const streams: Values[] = [];
  const container: Values = {};
  if (/^csv(?:=|$)/u.test(writer)) {
    // Supported recorded CSV profiles contain only numeric/codec fields; quoting,
    // custom separators and arbitrary tag columns are deliberately not guessed.
    if (writer !== "csv=p=0" && writer !== "csv=print_section=0") return undefined;
    for (const line of stdout.trim().split(/\r?\n/u).filter(Boolean)) {
      const values = line.split(",");
      if (selected.stream.length && values.length === selected.stream.length) {
        streams.push(Object.fromEntries(selected.stream.map((field, index) => [field, values[index]])));
      } else if (selected.format && values.length === 1) container.duration = values[0];
      else return undefined;
    }
  } else if (/^default(?:=(?:nw|noprint_wrappers)=1)?$/u.test(writer)) {
    let current: Values = {};
    let kind = selected.stream.length ? "stream" : "format";
    const flush = () => {
      if (Object.keys(current).length) {
        if (kind === "format" || (!current.codec_type && !current.codec_name && selected.format)) Object.assign(container, current);
        else streams.push(current);
      }
      current = {};
    };
    for (const line of stdout.split(/\r?\n/u)) {
      if (line === "[STREAM]" || line === "[FORMAT]") { flush(); kind = line === "[STREAM]" ? "stream" : "format"; }
      else if (line === "[/STREAM]" || line === "[/FORMAT]") flush();
      else {
        const at = line.indexOf("=");
        const key = line.slice(0, at);
        if (at < 0 || !order.includes(key)) continue;
        if (key in current) flush();
        current[key] = line.slice(at + 1);
      }
    }
    flush();
  } else return undefined;
  return { streams, format: container };
}

export function probesComplete(probes: { words: string[]; stdout: string }[]): boolean {
  const video: Values[] = [];
  const audio: Values[] = [];
  const formats: Values[] = [];
  let unavailableVideoDuration = false;
  for (const probe of probes) {
    const facts = parse(probe.words, probe.stdout);
    if (!facts) continue;
    formats.push(facts.format);
    const selector = probe.words.includes("-select_streams") ? argument(probe.words, "-select_streams") : undefined;
    for (const fields of facts.streams) {
      const role = fields.codec_type ?? (selector === "v:0" ? "video" : selector === "a:0" ? "audio" :
        fields.width !== undefined && fields.height !== undefined ? "video" : undefined);
      if (role === "video") {
        video.push(fields);
        if (projection(probe.words).stream.includes("duration") && (fields.duration === undefined || fields.duration === "N/A")) unavailableVideoDuration = true;
      }
      if (role === "audio") audio.push(fields);
    }
  }
  const numbers = (rows: Values[], key: string) => rows.flatMap(row => row[key] === undefined || row[key] === "N/A" ? [] : [Number(row[key])]);
  const valid = (values: number[], expected: number, tolerance = 0) => values.length > 0 && values.every(value => Number.isFinite(value) && Math.abs(value - expected) <= tolerance);
  const container = numbers(formats, "duration");
  const duration = numbers(video, "duration");
  return video.length > 0 && audio.length > 0 && valid(numbers(video, "width"), 1920) &&
    valid(numbers(video, "height"), 1080) && valid(duration.length ? duration : unavailableVideoDuration ? container : [], 20, 1 / 30) &&
    valid(numbers(audio, "duration"), 20, 0.1) && (!container.length || valid(container, 20, 1 / 30));
}
