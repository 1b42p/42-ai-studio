import { posix } from "node:path";

const ARGUMENT = String.raw`("[^"\n$\\\x60]+"|'[^'\n]+'|[^\s"';&|<>$\\\x60]+)`;
const SIZE_OPERATION = [
  String.raw`test\s+-s`,
  String.raw`stat(?:\s+(?:-c\s*|--format(?:=|\s+))["']?(?:%s(?: bytes)?|%n %s bytes)["']?)?`,
  String.raw`wc\s+(?:-c|--bytes)(?:\s*<)?`,
].join("|");

function unquote(value: string): string {
  return value.replace(/^["']|["']$/gu, "");
}

function positiveBytes(value: unknown): boolean {
  return (
    (typeof value === "string" || typeof value === "number") &&
    /^\d+$/u.test(String(value)) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}

interface ProbeRequest {
  requestsSize: boolean;
}

function probeRequest(
  command: string,
  matchesPath: (path: string) => boolean,
): ProbeRequest | null {
  const invocation =
    /^(?:(?:npx\s+(?:--yes\s+)?)?remotion\s+)?ffprobe\s+(.+)$/u.exec(command);
  if (!invocation) {
    return null;
  }

  // Только параметры инспекции и один входной файл, без shell-выражений.
  const argumentsPattern = new RegExp(String.raw`\s*${ARGUMENT}`, "gy");
  const args: string[] = [];
  let offset = 0;
  while (offset < invocation[1].length) {
    argumentsPattern.lastIndex = offset;
    const argument = argumentsPattern.exec(invocation[1]);
    if (!argument) {
      return null;
    }
    args.push(unquote(argument[1]));
    offset = argumentsPattern.lastIndex;
  }

  let allFormatEntries = false;
  const formatEntries = new Set<string>();
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (["-show_format", "-show_streams", "-hide_banner"].includes(option)) {
      if (option === "-show_format") {
        allFormatEntries = true;
      }
      continue;
    }
    if (
      ["-v", "-loglevel", "-of", "-print_format", "-show_entries"].includes(
        option,
      )
    ) {
      const value = args[++index];
      if (!value || value.startsWith("-")) {
        return null;
      }
      if (option === "-show_entries") {
        for (const section of value.split(":")) {
          const [name, fields] = section.split("=");
          if (name !== "format") {
            continue;
          }
          allFormatEntries = fields === undefined;
          if (fields !== undefined) {
            for (const field of fields.split(",")) {
              formatEntries.add(field);
            }
          }
        }
      }
      continue;
    }
    if (option.startsWith("-")) {
      return null;
    }
    paths.push(option);
  }

  return paths.length === 1 && matchesPath(paths[0])
    ? { requestsSize: allFormatEntries || formatEntries.has("size") }
    : null;
}

function listingSize(
  stdout: string,
  humanReadable: boolean,
  matchesPath: (path: string) => boolean,
): boolean {
  // GNU ls -l: тип/права, число ссылок, владелец, группа, размер, дата, имя.
  const listing =
    /^(-[rwxstST-]{9}[.+@]?)\s+\d+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/u.exec(
      stdout,
    );
  if (!listing || !matchesPath(unquote(listing[3]))) {
    return false;
  }
  if (positiveBytes(listing[2])) {
    return true;
  }
  return (
    humanReadable &&
    /^\d+(?:[.,]\d+)?[KMGTPEZYRQ]$/u.test(listing[2]) &&
    Number(listing[2].slice(0, -1).replace(",", ".")) > 0
  );
}

function sizeOutput(
  operation: string,
  stdout: string,
  matchesPath: (path: string) => boolean,
): boolean {
  if (operation.startsWith("test")) {
    return true;
  }
  if (operation.includes("%n")) {
    const namedSize = /^(.+)\s+(\d+)\s+bytes$/u.exec(stdout.trim());
    return (
      !!namedSize && matchesPath(namedSize[1]) && positiveBytes(namedSize[2])
    );
  }
  const size = operation.startsWith("wc")
    ? /^(\d+)(?:[\t ]+(.+))?$/u.exec(stdout.trim())
    : (/^([0-9]+)$/mu.exec(stdout) ??
      /(?:^|\s)(\d+)\s+bytes$/u.exec(stdout.trim()) ??
      /\bSize:\s*(\d+)\b/u.exec(stdout));
  return !!size && positiveBytes(size[1]) && (!size[2] || matchesPath(size[2]));
}

function probeSize(stdout: string): boolean {
  try {
    const probe: unknown = JSON.parse(stdout);
    return (
      typeof probe === "object" &&
      probe !== null &&
      "format" in probe &&
      typeof probe.format === "object" &&
      probe.format !== null &&
      "size" in probe.format &&
      positiveBytes(probe.format.size)
    );
  } catch {
    return positiveBytes(/^size=(\d+)$/mu.exec(stdout)?.[1]);
  }
}

/** Ограниченная грамматика: [cd &&] [ls &&] [stat/wc/test &&] [ffprobe]. */
export function inspectVideoFile(
  command: string,
  stdout: string,
  video: string,
) {
  if (/[\r\n]/u.test(command)) {
    return { nonempty: false, probeStdout: null };
  }
  const parts = command.trim().split(/\s*&&\s*/u);
  let cwd = "/workspace";
  const cd = new RegExp(String.raw`^cd\s+${ARGUMENT}$`, "u").exec(parts[0]);
  if (cd) {
    cwd = posix.resolve(cwd, unquote(cd[1]));
    parts.shift();
  }
  const path = posix.resolve("/workspace", video);
  const matchesPath = (operand: string) =>
    posix.resolve(cwd, unquote(operand)) === path;
  const listing = new RegExp(
    String.raw`^ls\s+(-l|-lh|-hl)\s+(?:--\s+)?${ARGUMENT}$`,
    "u",
  ).exec(parts[0] ?? "");
  if (listing) {
    if (!matchesPath(listing[2])) {
      return { nonempty: false, probeStdout: null };
    }
    parts.shift();
  }
  const size = new RegExp(
    String.raw`^(${SIZE_OPERATION})\s+(?:--\s+)?${ARGUMENT}$`,
    "u",
  ).exec(parts[0] ?? "");
  if (size) {
    if (!matchesPath(size[2])) {
      return { nonempty: false, probeStdout: null };
    }
    parts.shift();
  }
  const probe = parts.length === 1 ? probeRequest(parts[0], matchesPath) : null;
  if ((parts.length > 0 && !probe) || (!listing && !size && !probe)) {
    return { nonempty: false, probeStdout: null };
  }

  const lines = stdout.trim().split("\n");
  const listingLines = lines.filter((line) =>
    /^[bcdlps-][rwxstST-]{9}/u.test(line),
  );
  const hasListing =
    !!listing &&
    listingLines.length === 1 &&
    listingSize(lines[0], listing[1] !== "-l", matchesPath) &&
    (probe !== null || lines.length === 1);
  const probeStdout = probe
    ? listing && listingLines.length === 1 && listingLines[0] === lines[0]
      ? lines.slice(1).join("\n").trim()
      : stdout.trim()
    : null;
  return {
    nonempty: size
      ? sizeOutput(size[1], stdout, matchesPath)
      : listing
        ? hasListing
        : !!probe?.requestsSize && probeSize(stdout),
    probeStdout,
  };
}
