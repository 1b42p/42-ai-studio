import { createHash, timingSafeEqual } from "node:crypto";
import { extractBearerToken, type AuthResult } from "eve/channels/auth";
import type { SessionAuthContext } from "eve/context";

export interface EvalAuthConfig {
  readonly appEvalMode: boolean;
  readonly appVideoEvalSandbox?: boolean;
  readonly eveEvalAuthToken: string | undefined;
  readonly appUrl: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Проверяется целиком: одного пользовательского атрибута eval недостаточно. */
export function isEvalPrincipal(principal: SessionAuthContext | null | undefined): boolean {
  return principal?.authenticator === "studio-eval" &&
    principal.principalType === "user" && principal.principalId === "eval" &&
    principal.attributes.eval === "1";
}

/** Неизвестный bearer не перехватывает обычный путь входа по cookie. */
export function authenticateEval(
  request: Request,
  config: EvalAuthConfig,
  nodeEnv = process.env.NODE_ENV,
): AuthResult | null {
  // Сам eve eval тоже trim() значения EVE_EVAL_AUTH_TOKEN перед отправкой.
  const expected = config.eveEvalAuthToken?.trim();
  if (!config.appEvalMode || nodeEnv === "production" ||
    expected === undefined || expected.length < 24 ||
    !isLocalUrl(config.appUrl) || !isLocalUrl(request.url)) return null;

  const token = extractBearerToken(request.headers.get("authorization"));
  if (token === undefined || token === null) return null;
  // Равные по длине SHA-256 позволяют сравнить и токены разной длины,
  // не раскрывая длину секрета ранним возвратом timingSafeEqual.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(token), digest(expected))) return null;

  return {
    authenticator: "studio-eval",
    principalType: "user",
    principalId: "eval",
    attributes: {
      eval: "1",
      ...(config.appVideoEvalSandbox ? {
        videoEval: "1",
        videoEvalRenderFails: request.headers.get("x-studio-video-eval") === "render-failure" ? "1" : "0",
      } : {}),
    },
    allowToolStubs: true,
  };
}
