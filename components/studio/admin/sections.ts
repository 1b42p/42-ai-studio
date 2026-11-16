/**
 * Разделы админки. Один массив на проект: #31 и #32 добавляют сюда
 * «Песочницы» и «Расход», «Ключи» — когда появятся их страницы.
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
];
