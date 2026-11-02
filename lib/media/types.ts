/** Общий вид файла сообщения: его отдают `/api/sessions/:id/files` и клиент. */
import type { MessageFileReason, MessageFileState } from "@/lib/db/schema";

export interface MessageFileView {
  readonly messageId: string;
  readonly path: string;
  readonly state: MessageFileState;
  readonly reason: MessageFileReason | null;
  readonly mediaId: string | null;
  readonly contentType: string | null;
  readonly name: string;
  readonly sizeBytes: number | null;
}

export interface MessageFilesResponse {
  readonly files: MessageFileView[];
}
