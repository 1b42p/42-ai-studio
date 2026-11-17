"use client";

import { PageError } from "@/components/studio/page-error";
import { PublicShell } from "@/components/studio/public-shell";

export default function PublicErrorPage({ retry }: { retry: () => void }) {
  return (
    <PublicShell>
      <PageError retry={retry} />
    </PublicShell>
  );
}
