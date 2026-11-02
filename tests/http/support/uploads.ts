/** Помощники HTTP-тестов загрузки файлов пользователя (#9). */
import { inject } from "vitest";

import type { User } from "../../../lib/db/schema";
import { loginAs } from "./auth";

export interface UploadTicketRequest {
  appSessionId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}

/** Ответ `POST /api/uploads`, когда он успешен. */
export interface UploadTicket {
  id: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
  fileUrl: string;
}

export interface UploadResponse {
  status: number;
  body: unknown;
}

export interface UploadOptions {
  /** Экземпляр приложения; по умолчанию основной из глобальной подготовки. */
  baseUrl?: string;
}

/** `POST /api/uploads` с произвольным телом или без него. */
export async function requestUpload(
  user: User,
  body: unknown,
  options: UploadOptions = {},
): Promise<UploadResponse> {
  const cookie = await loginAs(user);
  const response = await fetch(new URL("/api/uploads", options.baseUrl ?? inject("appUrl")), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Ошибка не в JSON — это тоже ответ, его и проверяем.
  }
  return { status: response.status, body: parsed };
}

/** Создаёт строку `media` и подписанную ссылку; ошибка — исключение. */
export async function createUpload(
  user: User,
  request: UploadTicketRequest,
  options: UploadOptions = {},
): Promise<UploadTicket> {
  const response = await requestUpload(user, request, options);
  if (response.status !== 201) {
    throw new Error(`POST /api/uploads вернул ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body as UploadTicket;
}

/** `PUT` байтов по подписанной ссылке. */
export async function putUpload(
  uploadUrl: string,
  bytes: Uint8Array | string,
  contentType: string,
): Promise<Response> {
  return fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: typeof bytes === "string" ? bytes : new Uint8Array(bytes).buffer as ArrayBuffer,
    redirect: "manual",
  });
}

/** Полный путь браузера: строка `media`, подпись, `PUT` байтов. */
export async function uploadBytes(
  user: User,
  request: UploadTicketRequest,
  bytes: Uint8Array | string,
  options: UploadOptions = {},
): Promise<UploadTicket> {
  const ticket = await createUpload(user, request, options);
  const response = await putUpload(ticket.uploadUrl, bytes, ticket.headers["Content-Type"] ?? "");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`PUT по подписанной ссылке вернул ${response.status}: ${await response.text()}`);
  }
  return ticket;
}
