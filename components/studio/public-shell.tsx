import type { ReactNode } from "react";

import { Brand } from "@/components/studio/brand";
import { PublicThemeToggle } from "@/components/studio/public-theme-toggle";
import { SkipLink } from "@/components/studio/skip-link";
import { ButtonLink } from "@/components/studio/button-link";
import { cn } from "@/lib/utils";

export interface PublicNavLink {
  title: string;
  href: string;
}

export interface PublicShellProps {
  children: ReactNode;
  navLinks?: readonly PublicNavLink[];
  actions?: ReactNode;
  fullWidth?: boolean;
}

/** Каркас публичных страниц: шапка с названием сервиса и переключателем темы. */
export function PublicShell({
  children,
  navLinks = [],
  actions,
  fullWidth = false,
}: PublicShellProps) {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <header className={cn(
        "sticky top-0 z-30 shrink-0 bg-background/85 backdrop-blur-xl",
        fullWidth ? "border-b border-border/60 px-5 py-2 md:px-8" : "px-3 py-3 md:px-4",
      )}>
        <div className={cn(
          "mx-auto flex min-h-14 w-full max-w-7xl items-center justify-between gap-2",
          !fullWidth && "px-3 lg:px-6",
        )}>
          <a href="/" aria-label="42 AI Studio — главная" className="shrink-0">
            <Brand />
          </a>
          {navLinks.length > 0 && (
            <nav aria-label="Главная" className="ml-auto hidden items-center md:flex">
              {navLinks.map((link) => (
                <ButtonLink
                  key={link.href}
                  variant="ghost"
                  size="sm"
                  href={link.href}
                >
                  {link.title}
                </ButtonLink>
              ))}
            </nav>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <PublicThemeToggle />
            {actions}
          </div>
        </div>
      </header>
      <main
        id="studio-content"
        tabIndex={-1}
        className={cn(
          "flex min-w-0 w-full flex-1 flex-col",
          !fullWidth && "items-center justify-center px-4 py-12",
        )}
      >
        {children}
      </main>
    </div>
  );
}
