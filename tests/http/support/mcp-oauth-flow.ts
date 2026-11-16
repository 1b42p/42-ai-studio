import type { MessageStreamEvent } from "eve/client";

import { loadConfig } from "@/lib/config";
import type { User } from "@/lib/db/schema";
import { fetchApp } from "./app";
import { loginAs } from "./auth";
import { eveClientAs } from "./chat";

export type RequiredAuthorization = Extract<MessageStreamEvent, { type: "authorization.required" }>;

/** Browser navigation intentionally has no studio cookie: the callback is a public webhook. */
export async function completeOAuthInBrowser(event: RequiredAuthorization) {
  const authorize = await fetch(event.data.authorization!.url!, { redirect: "manual" });
  if (authorize.status !== 302) throw new Error(`OAuth authorize: ${authorize.status}`);
  const location = authorize.headers.get("location")!;
  if (new URL(location).origin !== new URL(loadConfig().appUrl).origin) {
    throw new Error("OAuth callback does not use public APP_URL");
  }
  const callback = await fetch(location, { redirect: "manual" });
  if (callback.status !== 200) throw new Error(`OAuth callback: ${callback.status}`);
  return location;
}

/** Consume one live response across its authorization pause, without closing/reopening it. */
export async function oauthTurn(
  user: User,
  appSessionId: string,
  text: string,
  onRequired: (event: RequiredAuthorization) => Promise<unknown> = completeOAuthInBrowser,
) {
  const client = await eveClientAs(user, appSessionId);
  const cookie = await loginAs(user);
  const current = await fetchApp(`/api/sessions/${appSessionId}`, { headers: { cookie } });
  const { eveSessionId } = await current.json() as { eveSessionId: string | null };
  const signal = AbortSignal.timeout(60_000);
  const response = eveSessionId
    ? await client.sessions.attach(eveSessionId).send(text, { signal })
    : (await client.sessions.create({ message: text, signal })).response;
  const events: MessageStreamEvent[] = [];
  for await (const event of response) {
    events.push(event);
    if (event.type === "authorization.required") await onRequired(event);
    if (event.type === "session.waiting") break;
    if (event.type === "session.failed") throw new Error(event.data.message);
  }
  return events;
}
