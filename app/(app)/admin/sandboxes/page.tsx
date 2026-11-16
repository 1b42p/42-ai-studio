import { AdminSandboxesPanel } from "@/components/studio/admin/resources/admin-sandboxes-panel";
import { requireOperator } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function AdminSandboxesRoute() {
  await requireOperator("/admin/sandboxes");
  return <AdminSandboxesPanel />;
}
