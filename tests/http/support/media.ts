/** Помощники HTTP-тестов файлов ответа агента (#8). */
import type { User } from "../../../lib/db/schema";
import type { MessageFileView, MessageFilesResponse } from "../../../lib/media/types";
import { sleep } from "../../../lib/sleep";
import { fetchApp } from "./app";
import { loginAs } from "./auth";

/** Список файлов сессии. */
export async function sessionFiles(
  user: User,
  appSessionId: string,
): Promise<MessageFileView[]> {
  const cookie = await loginAs(user);
  const response = await fetchApp(`/api/sessions/${appSessionId}/files`, {
    headers: { cookie },
  });
  if (response.status !== 200) {
    throw new Error(`GET /api/sessions/:id/files вернул ${response.status}`);
  }
  return ((await response.json()) as MessageFilesResponse).files;
}

/** Опрашивает список файлов, пока условие не выполнится. */
export async function waitForSessionFiles(
  user: User,
  appSessionId: string,
  predicate: (files: readonly MessageFileView[]) => boolean,
  options: { timeoutMs?: number } = {},
): Promise<MessageFileView[]> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let last: MessageFileView[] = [];

  while (Date.now() < deadline) {
    last = await sessionFiles(user, appSessionId);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(
    `файлы сессии не дошли до нужного состояния за ${timeoutMs} мс: ${JSON.stringify(last)}`,
  );
}

/** Развёрнутая ссылка `/api/media/:id` без перехода по ней. */
export async function mediaRedirect(
  user: User,
  mediaId: string,
  query = "",
): Promise<{ status: number; location: string | null }> {
  const cookie = await loginAs(user);
  const response = await fetchApp(`/api/media/${mediaId}${query}`, {
    headers: { cookie },
  });
  return { status: response.status, location: response.headers.get("location") };
}

/** Байты по подписанной ссылке из `Location`. */
export async function readSigned(location: string): Promise<Uint8Array> {
  const response = await fetch(location, { redirect: "manual" });
  if (response.status !== 200) {
    throw new Error(`подписанная ссылка вернула ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
