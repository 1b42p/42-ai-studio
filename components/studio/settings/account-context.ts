"use client";

import { createContext, useContext } from "react";

import type { PublicUser } from "@/lib/auth/user";

export interface SettingsAccount {
  user: PublicUser;
  onLogout: () => void | Promise<void>;
}

export const SettingsAccountContext = createContext<SettingsAccount | null>(null);

export function useSettingsAccount(): SettingsAccount {
  const account = useContext(SettingsAccountContext);
  if (account === null) throw new Error("SettingsAccountContext is required");
  return account;
}
