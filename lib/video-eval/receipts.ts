import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "video-eval-artifact:";

function signature(payload: string, token: string): string {
  return createHmac("sha256", token.trim()).update(`studio-video-eval-artifact:v1:${payload}`).digest("hex");
}

/** Квитанцию выдаёт исполнитель только после записи MP4, не общий статус shell. */
export function videoEvalReceipt(path: string, token: string): string {
  const payload = Buffer.from(JSON.stringify({ path })).toString("base64url");
  return `${PREFIX}${payload}.${signature(payload, token)}`;
}

export function videoEvalArtifacts(stdout: string, token: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(PREFIX) || line.length > 4096) continue;
    const match = /^([\w-]+)\.([0-9a-f]{64})$/.exec(line.slice(PREFIX.length));
    if (!match || !timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(signature(match[1], token), "hex"))) continue;
    try {
      const value: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      if (typeof value === "object" && value !== null && "path" in value && typeof value.path === "string") paths.push(value.path);
    } catch { /* Некорректная квитанция не подтверждает запись файла. */ }
  }
  return paths;
}
