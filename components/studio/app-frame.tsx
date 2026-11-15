"use client";

import { usePathname } from "next/navigation";

import { AppShell } from "@/components/studio/app-shell";
import { navItems } from "@/components/studio/nav";
import { UserMenu } from "@/components/studio/user-menu";
import { logout } from "@/components/studio/settings/logout";
import type { PublicUser } from "@/lib/auth/user";

/**
 * Клиентская оболочка приложения: знает текущий путь и обработчик выхода.
 * Сама раскладка `AppShell` остаётся свободной от Next.js и тестируется без
 * маршрутизатора.
 */
export function AppFrame({
  user,
  children,
}: {
  user: PublicUser | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <AppShell
      navItems={navItems}
      pathname={pathname}
      userSlot={user === null ? undefined : (
        <UserMenu
          user={user}
          onLogout={logout}
          items={navItems.filter((item) => item.href === "/settings")}
        />
      )}
    >
      {children}
    </AppShell>
  );
}
