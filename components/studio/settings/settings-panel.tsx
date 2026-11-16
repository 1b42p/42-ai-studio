"use client";

import { AlertCircleIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { PublicUser } from "@/lib/auth/user";
import type { Settings } from "@/lib/settings/schema";

import { logout } from "./logout";
import { SettingsPage } from "./settings-page";
import { useSettings } from "./use-settings";
import { McpContext, type McpServerView } from "./mcp-context";
import { useMcp } from "./use-mcp";

export function SettingsPanel({ initialSettings, initialMcpServers, user }: { initialSettings: Settings; initialMcpServers: McpServerView[]; user: PublicUser }) {
  const { settings, save, loadError, refresh } = useSettings(initialSettings);
  const mcp = useMcp(initialMcpServers);
  return (
    <>
      {loadError ? (
        <Alert className="mx-auto mt-4 max-w-2xl" variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>Не удалось обновить настройки.</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>Повторить</Button>
          </AlertAction>
        </Alert>
      ) : null}
      <McpContext.Provider value={mcp}>
        <SettingsPage settings={settings} save={save} user={user} onLogout={logout} />
      </McpContext.Provider>
    </>
  );
}
