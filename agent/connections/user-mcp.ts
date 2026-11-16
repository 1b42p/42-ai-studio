import { createHash } from "node:crypto";

import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { signInternalToken } from "@/lib/auth/internal-tokens";
import { loadConfig } from "@/lib/config";
import { createMcpOAuthAuthorization } from "@/lib/mcp/oauth";
import { listEnabledMcpServers } from "@/lib/mcp/service";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const principal = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (principal?.principalType !== "user" || principal.authenticator !== "studio") return null;
      try {
        const servers = await listEnabledMcpServers(principal.principalId);
        if (!servers.length) return null;
        return Object.fromEntries(servers.map((server) => {
          const fingerprint = createHash("sha256").update(JSON.stringify([server.url, server.authKind])).digest("hex").slice(0, 12);
          return [server.slug, defineMcpClientConnection({
            url: `${loadConfig().internalAppUrl}/api/mcp-proxy/${server.id}`,
            protocolVersionDiscovery: false,
            description: `Подключённый пользователем MCP-сервер «${server.name.replace(/[\p{Cc}]/gu, "").slice(0, 60)}»`,
            instanceKey: `${principal.principalId}:${server.id}:${fingerprint}`,
            ...(server.authKind === "oauth" ? {
              auth: { ...createMcpOAuthAuthorization(server.id), displayName: server.name },
            } : {}),
            headers: async () => ({
              "x-studio-mcp-token": await signInternalToken("mcp_proxy", { uid: principal.principalId, srv: server.id }),
            }),
          })];
        }));
      } catch {
        console.error("[user-mcp] Не удалось загрузить подключения.");
        return null;
      }
    },
  },
});
