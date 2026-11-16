import { AdminKeysPanel } from "@/components/studio/admin/keys/admin-keys-panel";
import { listAdminKeys } from "@/lib/admin/keys";
import type { AdminKeysPage } from "@/lib/admin/key-view";
import { requireOperator } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const EMPTY: AdminKeysPage = {
  items: [],
  defaults: { cpu: 2, memoryGb: 4, diskGb: 8 },
};

/** Раздел «Ключи»: первая страница собрана на сервере, секрет в неё не попадает. */
export default async function AdminKeysRoute() {
  await requireOperator("/admin/keys");

  let initialPage = EMPTY;
  let initialError = false;
  try {
    initialPage = await listAdminKeys(false);
  } catch {
    initialError = true;
  }

  return <AdminKeysPanel initialError={initialError} initialPage={initialPage} />;
}
