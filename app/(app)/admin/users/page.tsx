import { notFound } from "next/navigation";

import { AdminUsersPanel } from "@/components/studio/admin/users/admin-users-panel";
import { listAdminUsers, parseAdminUsersSearchParams } from "@/lib/admin/users";
import type { AdminUsersPage } from "@/lib/admin/types";
import { requireOperator } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const EMPTY_PAGE: AdminUsersPage = {
  items: [],
  nextCursor: null,
  totals: { users: 0, operators: 0, blocked: 0 },
};

/** Раздел «Пользователи»: первая страница собрана на сервере, фильтр — `userId`. */
export default async function AdminUsersRoute({
  searchParams,
}: {
  searchParams: Promise<{ userId?: string | string[] }>;
}) {
  await requireOperator("/admin/users");
  const params = await searchParams;
  const rawUserId = typeof params.userId === "string" ? params.userId : undefined;

  const search = new URLSearchParams();
  if (rawUserId !== undefined) search.set("userId", rawUserId);
  const parsed = parseAdminUsersSearchParams(search);
  if (!parsed.ok && rawUserId !== undefined) notFound();

  let initialPage = EMPTY_PAGE;
  let initialError = false;
  if (parsed.ok) {
    try {
      initialPage = await listAdminUsers(parsed.request);
    } catch {
      initialError = true;
    }
  } else {
    initialError = true;
  }

  return (
    <AdminUsersPanel
      initialError={initialError}
      initialPage={initialPage}
      initialUserId={parsed.ok ? parsed.request.userId : null}
    />
  );
}
