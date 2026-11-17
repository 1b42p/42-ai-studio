"use client";

import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";

import { navIcons, type NavItem } from "@/components/studio/nav";
import { useLogout } from "@/components/studio/use-logout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import type { PublicUser } from "@/lib/auth/user";

export interface UserMenuProps {
  user: PublicUser;
  /** Выход: запрос к `/api/auth/logout` и переход на `/login`. */
  onLogout: () => void | Promise<void>;
  items?: readonly Pick<NavItem, "title" | "href" | "icon">[];
}

/** Инициалы для аватара: первые буквы первых двух слов. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase("ru");
}

/**
 * Блок пользователя внизу боковой панели: аватар, имя, `@username` и меню
 * с выходом. Длинное имя усекается и не расширяет панель.
 */
export function UserMenu({ user, onLogout, items = [] }: UserMenuProps) {
  const { pending, failed, logout } = useLogout(onLogout);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuButton size="lg" className="h-auto min-w-0 rounded-xl bg-background/70 px-2.5 py-3 ring-1 ring-border" />}
        aria-label={`Аккаунт ${user.name}`}
      >
        <Avatar size="sm">
          {user.photoUrl !== null ? <AvatarImage src={user.photoUrl} alt="" /> : null}
          <AvatarFallback className="bg-primary/12 text-foreground">{initialsOf(user.name)}</AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-1 flex-col items-start text-left leading-tight">
          <span className="w-full truncate text-sm font-medium">{user.name}</span>
          {user.username !== null ? (
            <span className="w-full truncate text-xs text-muted-foreground">
              @{user.username}
            </span>
          ) : null}
        </span>
        <ChevronsUpDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{user.name}</DropdownMenuLabel>
          {items.map(({ title, href, icon }) => {
            const Icon = navIcons[icon];
            return (
              <DropdownMenuItem key={href} render={<a href={href} />}>
                <Icon />
                {title}
              </DropdownMenuItem>
            );
          })}
          {failed ? (
            <Alert variant="destructive">
              <AlertDescription>Не удалось выйти. Попробуйте ещё раз.</AlertDescription>
            </Alert>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            closeOnClick={false}
            onClick={() => void logout()}
          >
            <LogOutIcon />
            Выйти
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
