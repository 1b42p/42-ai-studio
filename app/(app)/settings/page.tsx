import { SettingsPanel } from "@/components/studio/settings/settings-panel";
import { requireUser } from "@/lib/auth/guard";
import { toPublicUser } from "@/lib/auth/user";
import { getSettings } from "@/lib/settings/service";

export default async function SettingsRoute() {
  const user = await requireUser("/settings");
  const settings = await getSettings(user.id);

  return <SettingsPanel initialSettings={settings} user={toPublicUser(user)} />;
}
