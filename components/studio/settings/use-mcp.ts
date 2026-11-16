"use client";

import { useState } from "react";
import type { McpCheck, McpServerView, McpState } from "./mcp-context";

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? "Не удалось выполнить запрос.");
  }
  return response.status === 204 ? null : response.json();
}

export function useMcp(initialServers: McpServerView[]): McpState {
  const [servers, setServers] = useState(initialServers);
  const [checks, setChecks] = useState<Record<string, McpCheck>>({});
  const check = async (id: string) => {
    try {
      const result = await api(`/api/mcp-servers/${id}/check`, { method: "POST" });
      setChecks((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setChecks((current) => ({ ...current, [id]: {
        ok: false, reason: "request", message: error instanceof Error ? error.message : "Не удалось проверить сервер.",
      } }));
    }
  };
  return {
    servers, checks, check,
    async add(input) {
      const server: McpServerView = await api("/api/mcp-servers", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      setServers((current) => [...current, server]);
      void check(server.id);
    },
    async toggle(id, enabled) {
      const server: McpServerView = await api(`/api/mcp-servers/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      setServers((current) => current.map((item) => item.id === id ? server : item));
    },
    async remove(id) {
      await api(`/api/mcp-servers/${id}`, { method: "DELETE" });
      setServers((current) => current.filter((item) => item.id !== id));
    },
    async signout(id) {
      await api(`/api/mcp-servers/${id}/signout`, { method: "POST" });
      setServers((current) => current.map((item) => item.id === id ? { ...item, connected: false } : item));
      setChecks((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
  };
}
