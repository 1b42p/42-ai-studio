import type { ReactNode } from "react";

import { Brand } from "@/components/studio/brand";
import { PublicThemeToggle } from "@/components/studio/public-theme-toggle";
import { Button } from "@/components/ui/button";
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
      <header className="sticky top-0 z-30 h-14 shrink-0 border-b bg-background">
        <div className="mx-auto flex h-full w-full max-w-7xl items-center justify-between gap-2 px-4 lg:px-8">
          <a href="/" aria-label="42 AI Studio — главная" className="shrink-0">
            <Brand />
          </a>
          {navLinks.length > 0 && (
            <nav aria-label="Главная" className="ml-auto hidden items-center gap-1 md:flex">
              {navLinks.map((link) => (
                <Button
                  key={link.href}
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  render={<a href={link.href} role="link" />}
                >
                  {link.title}
                </Button>
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
