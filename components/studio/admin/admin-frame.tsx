"use client";

import { usePathname, useRouter } from "next/navigation";

import { AdminShell } from "./admin-shell";
import { adminSections } from "./sections";

/** Связывает каркас админки с маршрутизатором Next.js. */
export function AdminFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <AdminShell
      onNavigate={(href) => router.push(href)}
      pathname={pathname}
      sections={adminSections}
    >
      {children}
    </AdminShell>
  );
}
