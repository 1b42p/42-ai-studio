/** Ответ `POST /api/uploads`: строка `media` и подписанная ссылка на загрузку. */
export interface UploadTicket {
  readonly id: string;
  readonly uploadUrl: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: string;
  readonly fileUrl: string;
}
