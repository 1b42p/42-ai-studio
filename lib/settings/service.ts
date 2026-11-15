import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { users } from "../db/schema";
import type { Settings, SettingsPatch } from "./schema";

const settingsColumns = {
  customInstructions: users.customInstructions,
  memoryEnabled: users.memoryEnabled,
};

export async function getSettings(userId: string): Promise<Settings> {
  const [settings] = await getDb()
    .select(settingsColumns)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (settings === undefined) throw new Error("Пользователь не найден.");
  return settings;
}

export async function saveSettings(userId: string, patch: SettingsPatch): Promise<Settings> {
  const [settings] = await getDb()
    .update(users)
    .set(patch)
    .where(eq(users.id, userId))
    .returning(settingsColumns);
  if (settings === undefined) throw new Error("Пользователь не найден.");
  return settings;
}
