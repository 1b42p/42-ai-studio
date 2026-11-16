/**
 * Разделы админки. Один массив на проект.
 */
export interface AdminSection {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

export const adminSections: readonly AdminSection[] = [
  { id: "users", title: "Пользователи", href: "/admin/users" },
  { id: "sandboxes", title: "Песочницы", href: "/admin/sandboxes" },
  { id: "usage", title: "Расход", href: "/admin/usage" },
  { id: "keys", title: "Ключи", href: "/admin/keys" },
];
