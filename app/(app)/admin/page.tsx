import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/auth/guard";

/** Корень админки ведёт в раздел пользователей. */
export default async function AdminPage() {
  await requireOperator("/admin");
  redirect("/admin/users");
}
