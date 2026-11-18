import type { ReactNode } from "react";
import { ArrowUpRightIcon, PlusIcon, SparklesIcon } from "lucide-react";

import { Brand } from "@/components/studio/brand";
import { SkipLink } from "@/components/studio/skip-link";
import { ButtonLink } from "@/components/studio/button-link";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/studio/theme-toggle";
import { navIcons, type NavItem } from "@/components/studio/nav";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export interface AppShellProps {
  navItems: NavItem[];
  /** Текущий путь: раскладка не зависит от роутера Next.js. */
  pathname: string;
  /** Узел в нижней части панели над переключателем темы. Заполнит #4. */
  userSlot?: ReactNode;
  children: ReactNode;
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Каркас приложения: постоянная боковая панель на компьютере и панель
 * поверх экрана на телефоне.
 */
export function AppShell({ navItems, pathname, userSlot, children }: AppShellProps) {
  const groups = [
    {
      label: "Рабочее пространство",
      items: navItems.filter((item) => item.requires !== "operator"),
    },
    {
      label: "Управление",
      items: navItems.filter((item) => item.requires === "operator"),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <SidebarProvider>
      <SkipLink />
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<a href="/" />}>
                <Brand />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <ButtonLink href="/s" className="w-full justify-between" size="lg">
            <span className="flex items-center gap-2"><PlusIcon data-icon="inline-start" />Новый ролик</span>
            <ArrowUpRightIcon data-icon="inline-end" />
          </ButtonLink>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = navIcons[item.icon];
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          render={<a href={item.href} />}
                          isActive={isActive(pathname, item.href)}
                          aria-current={isActive(pathname, item.href) ? "page" : undefined}
                          size="lg"
                        >
                          <Icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
          <SidebarGroup className="mt-auto">
            <SidebarGroupLabel className="gap-2"><SparklesIcon />Ваша видеостудия</SidebarGroupLabel>
            <SidebarGroupContent>
              От первой идеи до последнего кадра. Продолжайте с того места, где остановились.
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <Separator />
          {userSlot}
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-muted-foreground">Оформление</span>
            <ThemeToggle />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-md md:hidden">
          <SidebarTrigger />
          <Brand />
        </header>
        <div id="studio-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col p-3 md:p-6 lg:p-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
