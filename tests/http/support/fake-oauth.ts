import { OAUTH_ORIGIN, type OAuthModes, type OAuthRequest } from "./fake-oauth-provider";

interface Snapshot {
  requests: OAuthRequest[];
  issued: Array<{ access: string; refresh: string; clientSecret?: string }>;
  modes: OAuthModes;
}

async function control(body?: object): Promise<Snapshot> {
  const response = await fetch(`${OAUTH_ORIGIN}/__control`, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  } : { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`fake OAuth control: ${response.status}`);
  return response.json();
}

export const fakeOAuthProvider = {
  reset: () => control({ reset: true }),
  setModes: (modes: OAuthModes) => control({ modes }),
  expiresIn: (seconds: number) => control({ modes: { expiresIn: seconds } }),
  revokeAll: () => control({ revokeAll: true }),
  holdRevocation: () => control({ holdRevocation: true }),
  waitForRevocation: () => control({ waitForRevocation: true }),
  releaseRevocation: () => control({ releaseRevocation: true }),
  requests: async () => (await control()).requests,
  issued: async () => (await control()).issued,
};
