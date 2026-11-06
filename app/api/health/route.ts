/**
 * GET /api/health — публичная проверка здоровья: база (`SELECT 1`) и хранилище
 * (проверка бакета). На каждую проверку 2 секунды; зависание тоже даёт `error`.
 * Тексты ошибок наружу не уходят — они пишутся в журнал сервера.
 */
import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { getStorage } from "@/lib/s3";
import { evalRuntimeFingerprint, loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 2000;

type CheckResult = "ok" | "error";
type HealthBody = {
  status: "ok" | "error";
  checks: { database: CheckResult; storage: CheckResult };
};

async function runCheck(name: string, probe: () => Promise<void>): Promise<CheckResult> {
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`проверка «${name}» не уложилась в ${CHECK_TIMEOUT_MS} мс`)), CHECK_TIMEOUT_MS).unref();
      }),
    ]);
    return "ok";
  } catch (error) {
    console.error(`[health] ${name}:`, error);
    return "error";
  }
}

export async function GET(): Promise<Response> {
  const [database, storage] = await Promise.all([
    runCheck("database", async () => {
      await getDb().execute(sql`select 1`);
    }),
    runCheck("storage", async () => {
      await getStorage().headBucket();
    }),
  ]);

  const body: HealthBody = {
    status: database === "ok" && storage === "ok" ? "ok" : "error",
    checks: { database, storage },
  };

  return Response.json(body, {
    status: body.status === "ok" ? 200 : 503,
    headers: {
      ...(loadConfig().appVideoEvalSandbox ? { "x-studio-video-eval": "1" } : {}),
      ...(loadConfig().appEvalMode ? { "x-studio-eval-runtime": evalRuntimeFingerprint() } : {}),
    },
  });
}
