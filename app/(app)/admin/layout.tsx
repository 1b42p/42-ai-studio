import { notFound, redirect } from "next/navigation";

import { AdminFrame } from "@/components/studio/admin/admin-frame";
import { getCurrentUser } from "@/lib/auth/guard";

/**
 * Проверка раздела выше всех границ: вошедший не оператор видит обычный 404,
 * заблокированный — сообщение входа. Без входа страница сама перенаправляет с
 * точным `next`, потому что layout не знает текущий путь.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (user !== null && user.isBlocked) redirect("/login?error=blocked");
  if (user !== null && !user.isOperator) notFound();

  return <AdminFrame>{children}</AdminFrame>;
}
