import { SettingsPanel } from "@/components/studio/settings/settings-panel";
import { requireUser } from "@/lib/auth/guard";
import { toPublicUser } from "@/lib/auth/user";
import { getSettings } from "@/lib/settings/service";
import { listMcpServers, serializeServer } from "@/lib/mcp/service";

export default async function SettingsRoute() {
  const user = await requireUser("/settings");
  const settings = await getSettings(user.id);
  const servers = (await listMcpServers(user.id)).map((server) => {
    const value = serializeServer(server);
    return { ...value, createdAt: value.createdAt.toISOString() };
  });

  return <SettingsPanel initialSettings={settings} initialMcpServers={servers} user={toPublicUser(user)} />;
}
