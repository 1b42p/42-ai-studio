import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ResumedChat } from "@/components/studio/chat/resumed-chat";
import { getCurrentUser, requireUser } from "@/lib/auth/guard";
import { isUuid } from "@/lib/sessions/access";
import { findAppSessionForUser, SESSION_START_WINDOW_MS } from "@/lib/sessions/service";

const UNTITLED_DOCUMENT = "Новая сессия · 42 AI Studio";

/** Заголовок вкладки. Чужая сессия неотличима от отсутствующей. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}): Promise<Metadata> {
  const { sessionId } = await params;
  const user = await getCurrentUser();
  if (user === null || user.isBlocked || !isUuid(sessionId)) {
    return { title: UNTITLED_DOCUMENT };
  }
  const session = await findAppSessionForUser(sessionId, user.id);
  if (session === null || session.title === null || session.title === "") {
    return { title: UNTITLED_DOCUMENT };
  }
  return { title: `${session.title} · 42 AI Studio` };
}

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
      initialTitle={session.title}
      starting={starting}
    />
  );
}
