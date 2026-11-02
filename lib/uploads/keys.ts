/**
 * Ключ объекта загруженного файла (#9): `u/<user_id>/s/<app_session_id>/uploads/
 * <id строки media>/<очищенное имя>`. Каталог `uploads` — вид медиа из
 * соглашений хранилища.
 */
import { uploadKeyName } from "./name";

export function uploadObjectKey(input: {
  userId: string;
  appSessionId: string;
  uploadId: string;
  name: string;
}): string {
  return `u/${input.userId}/s/${input.appSessionId}/uploads/${input.uploadId}/${uploadKeyName(input.name)}`;
}
