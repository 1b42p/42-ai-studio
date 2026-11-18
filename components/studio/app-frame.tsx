"use client";

import { usePathname } from "next/navigation";

import { AppShell } from "@/components/studio/app-shell";
import { ChatDraftIdentityContext } from "@/components/studio/chat/draft-identity";
import type { NavItem } from "@/components/studio/nav";
import { logout } from "@/components/studio/settings/logout";
import { UserMenu } from "@/components/studio/user-menu";
import type { PublicUser } from "@/lib/auth/user";

/**
 * Клиентская оболочка приложения: знает текущий путь и обработчик выхода.
 * Пункты навигации приходят с сервера уже отфильтрованными по праву
 * оператора; сам признак оператора в `AppShell` не попадает.
 */
export function AppFrame({
  navItems,
  user,
  children,
}: {
  navItems: NavItem[];
  user: PublicUser | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <ChatDraftIdentityContext.Provider value={user?.id ?? null}>
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
    </ChatDraftIdentityContext.Provider>
  );
}
