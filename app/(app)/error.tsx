"use client";

import { PageError } from "@/components/studio/page-error";

export default function AppErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return <PageError retry={retry} inApp />;
}
