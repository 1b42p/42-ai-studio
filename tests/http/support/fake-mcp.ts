import { loadConfig } from "@/lib/config";
import type { FakeMcpRequest } from "./fake-mcp-server";

const base = () => `http://${loadConfig().ssrfTestAllowHosts[0]}`;

export const fakeMcpServer = {
  async requests(): Promise<FakeMcpRequest[]> {
    const response = await fetch(`${base()}/__requests`);
    if (!response.ok) throw new Error(`fake MCP requests: ${response.status}`);
    return response.json();
  },
  async reset(): Promise<void> {
    const response = await fetch(`${base()}/__reset`, { method: "POST" });
    if (!response.ok) throw new Error(`fake MCP reset: ${response.status}`);
  },
};
