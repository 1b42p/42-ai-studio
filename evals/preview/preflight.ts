import { posix } from "node:path";
import type { ToolStub } from "eve/evals";
import { esc, quote } from "../music/operation-patterns";
import { atomic, pathArg, projectPath } from "./commands";

/** Fixed initial manifest only: no shell evaluation or mutable filesystem. */
export function preflightStubs(seconds: number, files: Readonly<Record<string, string>>,
  media: readonly { path: string; size: number }[], keyPaths: readonly string[]): ToolStub[] {
  const P = projectPath(seconds);
  const sizes = Object.fromEntries([
    ...Object.entries(files).map(([path, content]) => [path, Buffer.byteLength(content)] as const),
    ...media.map(file => [file.path.startsWith(`${P}/`) ? file.path.slice(P.length + 1) : file.path, file.size] as const),
  ]);
  const stubs: ToolStub[] = [];
  const bash = (id: string, body: string, stdout: string): ToolStub => ({ id, tool: "bash", match: { command: { pattern: atomic(body, seconds) } },
    outcome: { response: { status: "completed", exitCode: 0, stdout, stderr: "", truncated: false } } });
  const immutable = Object.keys(sizes).filter(path => path !== "NOTES.md");
  stubs.push(bash("preflight-tests", `(?:test\\s+-s\\s+(?:${immutable.map(path => pathArg(path, seconds)).join("|")})|test\\s+-d\\s+${pathArg("node_modules", seconds)})`, ""));
  const directories = {
    "": [...Object.keys(files).filter(path => !path.includes("/")), "node_modules", "out", "src"],
    src: ["index.tsx"],
    out: [...new Set(Object.keys(sizes).filter(path => path.startsWith("out/")).map(path => path.slice(4).split("/")[0]))],
    "out/frames-1": Object.keys(sizes).filter(path => path.startsWith("out/frames-1/")).map(path => posix.basename(path)),
  };
  const longLine = (display: string, path: string) => {
    const file = Object.hasOwn(sizes, path);
    return `${file ? "-rw-r--r--" : "drwxr-xr-x"} 1 fixture fixture ${sizes[path] ?? 0} Jan 1 00:00 ${display}`;
  };
  for (const [directory, names] of Object.entries(directories)) {
    const sorted = [...names].sort();
    const target = directory ? `\\s+${pathArg(directory, seconds)}` : `(?:\\s+${quote(`(?:${esc(P)}/?|\\.)`)})?`;
    stubs.push(bash(`preflight-ls-${directory || "root"}`, `ls${target}`, sorted.join("\n") + "\n"));
    const rows = sorted.map(name => longLine(name, directory ? `${directory}/${name}` : name));
    stubs.push(bash(`preflight-ls-long-${directory || "root"}`, `ls\\s+-l${target}`, rows.join("\n") + "\n"));
    stubs.push(bash(`preflight-ls-all-${directory || "root"}`, `ls\\s+-(?:la|al)${target}`,
      [longLine(".", directory), longLine("..", posix.dirname(directory)), ...rows].join("\n") + "\n"));
  }
  for (const absolute of [false, true]) {
    const displayed = (path: string) => absolute ? `${P}/${path}` : path;
    for (const path of Object.keys(files).filter(path => path !== "NOTES.md")) {
      stubs.push(bash(`preflight-file-${path}-${absolute}`, `ls\\s+-(?:l|la|al)\\s+${quote(esc(displayed(path)))}`, longLine(displayed(path), path) + "\n"));
    }
    const keys = keyPaths.map(path => path.startsWith(`${P}/`) ? path.slice(P.length + 1) : path);
    stubs.push(bash(`preflight-key-list-${absolute}`, `ls\\s+-l\\s+${keys.map(path => quote(esc(displayed(path)))).join("\\s+")}`,
      [...keys].sort().map(path => longLine(displayed(path), path)).join("\n") + "\n"));
  }
  return stubs;
}
