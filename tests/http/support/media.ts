/** Помощники HTTP-тестов файлов ответа агента (#8). */
import { inject } from "vitest";

import type { User } from "../../../lib/db/schema";
import type { MessageFileView, MessageFilesResponse } from "../../../lib/media/types";
import { sleep } from "../../../lib/sleep";
import { loginAs } from "./auth";

export interface FilesRequestOptions {
  /** Экземпляр приложения; по умолчанию основной из глобальной подготовки. */
  baseUrl?: string;
}

function filesUrl(appSessionId: string, options: FilesRequestOptions): URL {
  return new URL(
    `/api/sessions/${appSessionId}/files`,
    options.baseUrl ?? inject("appUrl"),
  );
}

/** Список файлов сессии. */
export async function sessionFiles(
  user: User,
  appSessionId: string,
  options: FilesRequestOptions = {},
): Promise<MessageFileView[]> {
  const cookie = await loginAs(user);
  const response = await fetch(filesUrl(appSessionId, options), {
    headers: { cookie },
    redirect: "manual",
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
  options: FilesRequestOptions & { timeoutMs?: number } = {},
): Promise<MessageFileView[]> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let last: MessageFileView[] = [];

  while (Date.now() < deadline) {
    last = await sessionFiles(user, appSessionId, options);
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
  const response = await fetch(new URL(`/api/media/${mediaId}${query}`, inject("appUrl")), {
    headers: { cookie },
    redirect: "manual",
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
