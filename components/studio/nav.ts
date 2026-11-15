import { MessagesSquareIcon, SettingsIcon, type LucideIcon } from "lucide-react";

/** Пункт боковой навигации приложения. */
export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Показывает пункт только оператору. Проверку добавит #30. */
  requires?: "operator";
}

/**
 * Единственный список пунктов навигации на весь проект.
 * «Админку» (`requires: "operator"`) добавит #30.
 */
export const navItems: NavItem[] = [
  {
    title: "Сессии",
    href: "/s",
    icon: MessagesSquareIcon,
  },
  {
    title: "Настройки",
    href: "/settings",
    icon: SettingsIcon,
  },
];
