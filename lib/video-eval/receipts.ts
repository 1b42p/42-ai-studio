import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "video-eval-artifact:";

function signature(payload: string, token: string): string {
  return createHmac("sha256", token.trim()).update(`studio-video-eval-artifact:v1:${payload}`).digest("hex");
}

export interface VideoEvalRenderResult {
  readonly path: string;
  readonly exitCode: 0 | 1;
}

/** Подписывает исход самого кодирования, независимо от общего статуса shell. */
export function videoEvalReceipt(path: string, token: string, exitCode: 0 | 1 = 0): string {
  const payload = Buffer.from(JSON.stringify({ path, exitCode })).toString("base64url");
  return `${PREFIX}${payload}.${signature(payload, token)}`;
}

export function videoEvalRenderResults(stdout: string, token: string): VideoEvalRenderResult[] {
  const results: VideoEvalRenderResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(PREFIX) || line.length > 4096) continue;
    const match = /^([\w-]+)\.([0-9a-f]{64})$/.exec(line.slice(PREFIX.length));
    if (!match || !timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(signature(match[1], token), "hex"))) continue;
    try {
      const value: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      if (typeof value === "object" && value !== null && "path" in value && typeof value.path === "string" &&
        "exitCode" in value && (value.exitCode === 0 || value.exitCode === 1)) {
        results.push({ path: value.path, exitCode: value.exitCode });
      }
    } catch { /* Некорректная квитанция не подтверждает запись файла. */ }
  }
  return results;
}

export function videoEvalArtifacts(stdout: string, token: string): string[] {
  return videoEvalRenderResults(stdout, token).filter((result) => result.exitCode === 0).map((result) => result.path);
}
