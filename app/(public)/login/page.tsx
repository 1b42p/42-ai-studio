import { redirect } from "next/navigation";

import { LoginCard, type LoginError } from "@/components/studio/login-card";
import { PublicShell } from "@/components/studio/public-shell";
import { getCurrentUser } from "@/lib/auth/guard";
import { safeNextPath } from "@/lib/auth/next-path";
import { oidcSettings } from "@/lib/auth/settings";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

function errorFrom(value: string | string[] | undefined): LoginError {
  if (value === "blocked" || value === "failed") return value;
  return null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);

  const user = await getCurrentUser();
  if (user !== null && !user.isBlocked) redirect(next);

  const config = loadConfig();
  const error: LoginError = user?.isBlocked === true ? "blocked" : errorFrom(params.error);

  return (
    <PublicShell>
      <LoginCard
        next={next}
        telegramEnabled={oidcSettings(config) !== null}
        devLoginEnabled={config.devLoginEnabled}
        error={error}
      />
    </PublicShell>
  );
}
