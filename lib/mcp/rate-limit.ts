import { loadConfig } from "@/lib/config";

const checks = new Map<string, number[]>();

export function allowMcpCheck(userId: string, now = Date.now()): boolean {
  for (const [key, entries] of checks) {
    if (entries.every((time) => time <= now - 60_000)) checks.delete(key);
  }
  const recent = (checks.get(userId) ?? []).filter((time) => time > now - 60_000);
  if (recent.length >= 6) return false;
  recent.push(now);
  checks.set(userId, recent);
  return true;
}

export function resetCheckRateLimit(): void {
  if (!loadConfig().appTestMode) throw new Error("Доступно только в тестовом режиме.");
  checks.clear();
}
