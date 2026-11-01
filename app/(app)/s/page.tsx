import { ChatFrame } from "@/components/studio/chat/chat-frame";
import { NewChat } from "@/components/studio/chat/new-chat";
import { requireUser } from "@/lib/auth/guard";
import { listUserSessions, parseSessionListSearchParams } from "@/lib/sessions/list";

function queryValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

/** Новый чат: первая страница сессий собрана на сервере, в том числе для `?q=`. */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const user = await requireUser("/s");
  const params = await searchParams;
  const rawQuery = queryValue(params.q);
  const search = new URLSearchParams();
  if (rawQuery !== "") search.set("q", rawQuery);
  const parsed = parseSessionListSearchParams(search);

  return (
    <ChatFrame>
      <NewChat
        initialError={!parsed.ok}
        initialPage={
          parsed.ok
            ? await listUserSessions(user.id, parsed.request)
            : { items: [], nextCursor: null }
        }
        initialQuery={rawQuery.trim()}
      />
    </ChatFrame>
  );
}
