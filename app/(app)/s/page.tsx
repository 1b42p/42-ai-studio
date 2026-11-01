import { ChatFrame } from "@/components/studio/chat/chat-frame";
import { NewChat } from "@/components/studio/chat/new-chat";
import { requireUser } from "@/lib/auth/guard";

/** Новый чат: сессия приложения создаётся перед первой отправкой. */
export default async function SessionsPage() {
  await requireUser("/s");

  return (
    <ChatFrame>
      <NewChat />
    </ChatFrame>
  );
}
