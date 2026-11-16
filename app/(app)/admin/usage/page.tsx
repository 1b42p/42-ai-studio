import { notFound } from "next/navigation";
import { AdminUsagePanel } from "@/components/studio/admin/resources/admin-usage-panel";
import { validUsageDates } from "@/lib/admin/usage-period";
import { listAdminUsers, parseAdminUsersSearchParams } from "@/lib/admin/users";
import { requireOperator } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function AdminUsageRoute({ searchParams }: {
  searchParams: Promise<{ userId?: string | string[]; from?: string | string[]; to?: string | string[] }>;
}) {
  await requireOperator("/admin/usage");
  const params = await searchParams;
  const filter = new URLSearchParams();
  if (typeof params.userId === "string") filter.set("userId", params.userId);
  else if (params.userId !== undefined) notFound();
  const parsed = parseAdminUsersSearchParams(filter);
  if (!parsed.ok) notFound();
  const from = typeof params.from === "string" ? params.from : undefined;
  const to = typeof params.to === "string" ? params.to : undefined;
  if ((params.from !== undefined || params.to !== undefined) &&
      (!from || !to || !validUsageDates(from, to))) notFound();
  const users = parsed.request.userId
    ? await listAdminUsers({ ...parsed.request, limit: 1 })
    : null;
  const user = users?.items[0] ?? null;
  if (parsed.request.userId && !user) notFound();
  return <AdminUsagePanel
    initialUser={user ? { id: user.id, name: user.name, username: user.username } : null}
    initialPeriod={from && to ? { from, to } : undefined} />;
}
