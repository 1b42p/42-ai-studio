import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import {
  INVALID_SETTINGS_MESSAGE,
  SETTINGS_BODY_MAX_BYTES,
  settingsPatchSchema,
} from "@/lib/settings/schema";
import { getSettings, saveSettings } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

function tooLarge(): Response {
  return errorResponse(413, "too_large", "Размер запроса настроек не должен превышать 64 КиБ.");
}

async function readBody(request: Request): Promise<unknown | Response> {
  const declaredSize = request.headers.get("content-length");
  if (declaredSize !== null && Number(declaredSize) > SETTINGS_BODY_MAX_BYTES) return tooLarge();
  if (request.body === null) return errorResponse(400, "invalid_request", INVALID_SETTINGS_MESSAGE);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SETTINGS_BODY_MAX_BYTES) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks, size).toString("utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return errorResponse(400, "invalid_request", INVALID_SETTINGS_MESSAGE);
  } finally {
    reader.releaseLock();
  }
}

export async function GET(request: Request): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  return Response.json(await getSettings(user.id), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const originError = checkOrigin(request, loadConfig().appUrl);
  if (originError !== null) return originError;

  const body = await readBody(request);
  if (body instanceof Response) return body;
  const parsed = settingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    const lengthError = parsed.error.issues.find((issue) =>
      issue.code === "custom" && issue.path[0] === "customInstructions",
    );
    return errorResponse(400, "invalid_request", lengthError?.message ?? INVALID_SETTINGS_MESSAGE);
  }
  return Response.json(await saveSettings(user.id, parsed.data), {
    headers: { "Cache-Control": "no-store" },
  });
}
