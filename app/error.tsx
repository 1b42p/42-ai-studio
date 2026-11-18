"use client";

import dynamic from "next/dynamic";

import { PublicErrorLoading } from "@/components/studio/public-error-loading";

// The router resolves this boundary even on successful page loads. Keep its
// full UI out of that initial module evaluation, without disabling its SSR.
const PublicErrorPage = dynamic(
  () => import("@/components/studio/public-error-page"),
  { ssr: true, loading: PublicErrorLoading },
);

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return <PublicErrorPage retry={retry} />;
}
