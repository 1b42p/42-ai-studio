"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { settingsPatchSchema, type Settings, type SettingsPatch } from "@/lib/settings/schema";

import { SETTINGS_SAVE_ERROR, SettingsValidationError } from "./settings-error";

async function readSettings(response: Response): Promise<Settings> {
  if (!response.ok) {
    if (response.status === 400) {
      const body: unknown = await response.json().catch(() => null);
      if (body !== null && typeof body === "object" && "error" in body) {
        const error = body.error;
        if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string") {
          throw new SettingsValidationError(error.message);
        }
      }
    }
    throw new Error(SETTINGS_SAVE_ERROR);
  }
  return response.json() as Promise<Settings>;
}

export function useSettings(initialSettings: Settings) {
  const [settings, setSettings] = useState(initialSettings);
  const [loadError, setLoadError] = useState(false);
  const generation = useRef(0);
  const readController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const started = generation.current;
    setLoadError(false);
    try {
      const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
      const next = await readSettings(response);
      if (!controller.signal.aborted && started === generation.current) setSettings(next);
    } catch {
      if (!controller.signal.aborted && started === generation.current) setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => readController.current?.abort();
  }, [refresh]);

  const save = useCallback(async (patch: SettingsPatch): Promise<Settings> => {
    const result = settingsPatchSchema.safeParse(patch);
    if (!result.success) {
      throw new SettingsValidationError(result.error.issues[0]?.message ?? SETTINGS_SAVE_ERROR);
    }
    generation.current += 1;
    readController.current?.abort();
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.data),
    });
    const next = await readSettings(response);
    setSettings(next);
    setLoadError(false);
    return next;
  }, []);

  return { settings, save, loadError, refresh };
}
