/**
 * Разделы админки. Один массив на проект: #31 добавляет сюда
 * «Песочницы» и «Расход».
 */
export interface AdminSection {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

export const adminSections: readonly AdminSection[] = [
  { id: "users", title: "Пользователи", href: "/admin/users" },
  { id: "keys", title: "Ключи", href: "/admin/keys" },
];
