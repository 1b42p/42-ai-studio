"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Send } from "lucide-react";

import { ButtonLink } from "@/components/studio/button-link";
import { cn } from "@/lib/utils";

export type AuthState = "loading" | "anonymous" | "authenticated";

const AuthContext = createContext<AuthState>("loading");

export function AuthStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const request = useRef<Promise<AuthState> | null>(null);

  useEffect(() => {
    let active = true;
    // Keep the request across Strict Mode's effect replay, not across page visits.
    request.current ??= fetch("/api/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
    }).then(async (response): Promise<AuthState> => {
      // Drain no-store responses so the browser can finish the network request.
      await response.arrayBuffer();
      return response.status === 200 ? "authenticated" : "anonymous";
    }).catch((): AuthState => "anonymous");
    void request.current.then((result) => {
      if (active) setState(result);
    });
    return () => { active = false; };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuthState() {
  return useContext(AuthContext);
}

export function StudioLoginButton({
  compact = false,
  tone = "brand",
}: {
  compact?: boolean;
  tone?: "brand" | "contrast";
}) {
  const authenticated = useAuthState() === "authenticated";
  const title = authenticated ? "Открыть студию" : "Войти через Telegram";
  const Icon = authenticated ? ArrowRight : Send;

  return (
    <ButtonLink
      size={compact ? "default" : "xl"}
      variant={tone === "contrast" ? "secondary" : "default"}
      className={cn(
        "w-60 shrink-0",
        compact && "size-9 p-0 md:h-9 md:w-46 md:px-3",
      )}
      href={authenticated ? "/s" : "/api/auth/telegram/login?next=%2Fs"}
      aria-label={title}
    >
      <Icon data-icon="inline-start" aria-hidden="true" />
      <span className={cn(compact && "hidden md:inline")}>{title}</span>
    </ButtonLink>
  );
}
