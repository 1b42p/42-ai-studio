import { errors, jwtVerify, SignJWT, type JWTPayload } from "jose";

import { loadConfig } from "../config";

/** Реестр назначений расширяется вместе с потребителями служебных токенов. */
export interface InternalTokenClaims {
  eve_session_end: { sid: string };
}

export type InternalTokenPayload = JWTPayload & { purpose: string; iat: number; exp: number };

function signingKey(): Uint8Array {
  return new TextEncoder().encode(loadConfig().internalApiSecret);
}

export function signInternalToken<Purpose extends keyof InternalTokenClaims>(
  purpose: Purpose,
  claims: InternalTokenClaims[Purpose],
): Promise<string> {
  return new SignJWT({ ...claims, purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("studio-app")
    .setAudience("studio-internal")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(signingKey());
}

/** Проверяет подпись и общие ограничения; полномочия purpose проверяет потребитель. */
export async function verifyInternalToken(token: string): Promise<InternalTokenPayload> {
  const { payload } = await jwtVerify(token, signingKey(), {
    algorithms: ["HS256"],
    issuer: "studio-app",
    audience: "studio-internal",
    requiredClaims: ["iat", "exp", "purpose"],
    maxTokenAge: "60s",
  });
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
    payload.exp <= payload.iat || payload.exp - payload.iat > 60) {
    throw new errors.JWTClaimValidationFailed("Invalid internal token lifetime", payload, "exp", "check_failed");
  }
  if (typeof payload.purpose !== "string" || payload.purpose.length === 0) {
    throw new errors.JWTClaimValidationFailed("Invalid internal token purpose", payload, "purpose", "check_failed");
  }
  return payload as InternalTokenPayload;
}
