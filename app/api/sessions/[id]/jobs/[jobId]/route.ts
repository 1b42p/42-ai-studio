/**
 * GET /api/sessions/:id/jobs/:jobId — состояние фоновой команды `bash` (#11).
 * Песочницу не будит: остановленная отдаёт сохранённый хвост как `saved`,
 * живая — читает каталог `/tmp/.eve/jobs/<jobId>/`.
 */
import type { NextRequest } from "next/server";

import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import { readBashJob } from "@/lib/sandbox/job-service";
import { JOB_ID_PATTERN } from "@/lib/sandbox/job-types";
import { isUuid } from "@/lib/sessions/access";
import { findAppSessionForUser } from "@/lib/sessions/service";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; jobId: string }> },
): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  // Маршрут обновляет `bash_jobs` и `last_active_at`, поэтому чужой origin
  // отвергается так же, как на изменяющих маршрутах.
  const origin = checkOrigin(request, loadConfig().appUrl);
  if (origin !== null) return origin;

  const { id, jobId } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Сессия не найдена");

  const session = await findAppSessionForUser(id, user.id);
  if (session === null) return errorResponse(404, "not_found", "Сессия не найдена");
  if (!JOB_ID_PATTERN.test(jobId)) {
    return errorResponse(400, "invalid_request", "Некорректный идентификатор задания");
  }

  const result = await readBashJob(id, jobId);
  if (result.kind === "not_found") return errorResponse(404, "not_found", "Задание не найдено");
  if (result.kind === "unavailable") {
    return errorResponse(503, "unavailable", "Не удалось связаться с песочницей");
  }

  return Response.json(result.body, { headers: { "Cache-Control": "no-store" } });
}
