"use client";

import { createContext, useContext } from "react";

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  authKind: "none" | "bearer" | "headers" | "oauth";
  enabled: boolean;
  headerNames: string[];
  createdAt: string;
}

export type McpCheck = { ok: true; toolCount: number; tools: string[] } | { ok: false; reason: string; message: string };
export interface McpState {
  servers: McpServerView[];
  checks: Record<string, McpCheck | undefined>;
  add: (input: object) => Promise<void>;
  toggle: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  check: (id: string) => Promise<void>;
}

export const McpContext = createContext<McpState | null>(null);
export function useMcpContext() {
  return useContext(McpContext);
}
