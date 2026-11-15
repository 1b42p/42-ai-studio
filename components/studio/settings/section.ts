import type { ComponentType } from "react";

import type { Settings, SettingsPatch } from "@/lib/settings/schema";

export interface SettingsSectionProps {
  settings: Settings;
  save: (patch: SettingsPatch) => Promise<Settings>;
}

export interface SettingsSection {
  id: string;
  title: string;
  description: string;
  Component: ComponentType<SettingsSectionProps>;
}
