import { notFound } from "next/navigation";

import { ResumedChat } from "@/components/studio/chat/resumed-chat";
import { requireUser } from "@/lib/auth/guard";
import { isUuid } from "@/lib/sessions/access";
import { findAppSessionForUser, SESSION_START_WINDOW_MS } from "@/lib/sessions/service";

/**
 * Беседа `/s/[sessionId]`: история берётся из `session_events`, поток eve
 * продолжается с сохранённой позиции. Чужая и несуществующая сессия
 * неразличимы — страница 404.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const user = await requireUser(`/s/${sessionId}`);

  if (!isUuid(sessionId)) notFound();
  const session = await findAppSessionForUser(sessionId, user.id);
  if (session === null) notFound();

  const starting =
    session.startRequestedAt !== null &&
    Date.now() - session.startRequestedAt.getTime() < SESSION_START_WINDOW_MS;

  return (
    <ResumedChat
      appSessionId={session.id}
      initialEveSessionId={session.eveSessionId}
      starting={starting}
    />
  );
}
