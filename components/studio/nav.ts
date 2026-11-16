import { MessagesSquareIcon, SettingsIcon, ShieldIcon, type LucideIcon } from "lucide-react";

/** Значок пункта навигации: имя, а не компонент, чтобы массив был сериализуемым. */
export type NavIcon = "sessions" | "settings" | "admin";

/** Пункт боковой навигации приложения. */
export interface NavItem {
  title: string;
  href: string;
  icon: NavIcon;
  /** Показывает пункт только оператору. */
  requires?: "operator";
}

/** Значки пунктов: компоненты живут только в клиентском графе. */
export const navIcons: Record<NavIcon, LucideIcon> = {
  sessions: MessagesSquareIcon,
  settings: SettingsIcon,
  admin: ShieldIcon,
};

/** Единственный список пунктов навигации на весь проект. */
export const navItems: NavItem[] = [
  {
    title: "Сессии",
    href: "/s",
    icon: "sessions",
  },
  {
    title: "Настройки",
    href: "/settings",
    icon: "settings",
  },
  {
    title: "Админка",
    href: "/admin",
    icon: "admin",
    requires: "operator",
  },
];

/**
 * Пункты для оболочки: `is_operator` приходит из проверки пользователя на
 * сервере. Скрытие — удобство, а не защита: страницы и маршруты проверяют
 * право сами.
 */
export function navItemsFor(isOperator: boolean): NavItem[] {
  return isOperator ? navItems : navItems.filter((item) => item.requires !== "operator");
}
