import { eq } from "drizzle-orm";
import type { InstrumentationModelCallCompletedEvent } from "eve/instrumentation";

import { loadConfig } from "../config";
import { getDb } from "../db/client";
import { appSessions, usageRecords } from "../db/schema";
import { sleep } from "../sleep";
import { modelTokenAmounts } from "./tokens";

/** Один вызов провайдера; rootSessionId привязывает и расход копий к владельцу. */
export async function recordModelUsage(event: InstrumentationModelCallCompletedEvent): Promise<void> {
  const config = loadConfig();
  // Выделенный eval-процесс не обслуживает пользователей и не имеет их привязок.
  if (config.appStubEvalSandbox || config.appVideoEvalSandbox) return;
  const amounts = modelTokenAmounts(event.usage);
  // Не искать сессию и не предупреждать, если провайдер не сообщил расход.
  if (amounts.length === 0) return;
  const recordedAt = new Date();
  const eveSessionId = event.scope.rootSessionId ?? event.scope.sessionId;

  try {
    const database = getDb();
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const [session] = await database
        .select({ id: appSessions.id, userId: appSessions.userId })
        .from(appSessions)
        .where(eq(appSessions.eveSessionId, eveSessionId))
        .limit(1);

      if (session !== undefined) {
        await database.insert(usageRecords).values(amounts.map(({ kind, amount }) => ({
          userId: session.userId,
          appSessionId: session.id,
          kind,
          amount,
          sourceKey: event.idempotencyKey,
          recordedAt,
        }))).onConflictDoNothing();
        return;
      }
      if (attempt < 3) await sleep(1000);
    }
    console.warn("[usage:model] session_not_found: Сессия расхода не найдена.");
  } catch {
    // Исключения БД могут содержать запросы и параметры: не журналировать их.
    console.warn("[usage:model] write_failed: Не удалось сохранить расход токенов.");
  }
}
