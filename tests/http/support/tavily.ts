/** Управление тестовым Tavily без общего состояния между процессами Vitest. */
import { loadConfig } from "../../../lib/config";
import type { TavilyCall, TavilyMode } from "./tavily-server";

export const tavilyStub = {
  async setMode(mode: TavilyMode, count: number | null = null, retryAfter = "1"): Promise<void> {
    const response = await fetch(`${loadConfig().tavilyApiUrl}/__control`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, count, retryAfter }),
    });
    if (!response.ok) throw new Error(`tavily control ${response.status}`);
  },
  async calls(): Promise<TavilyCall[]> {
    const response = await fetch(`${loadConfig().tavilyApiUrl}/__calls`);
    if (!response.ok) throw new Error(`tavily calls ${response.status}`);
    return await response.json() as TavilyCall[];
  },
  reset(): Promise<void> { return this.setMode("ok"); },
};
