"use client";

import { useState } from "react";

export function useLogout(onLogout: () => void | Promise<void>) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function logout() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await onLogout();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return { pending, failed, logout };
}
