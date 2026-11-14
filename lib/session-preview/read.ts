import { previewError } from "./errors";
import { PREVIEW_MAX_BYTES } from "./validation";

/**
 * stat — только предварительная проверка: файл может вырасти до чтения.
 * Сохраняем не больше MAX + 1 байта и отменяем источник при превышении.
 */
export async function readPreviewStream(
  stream: ReadableStream<Uint8Array>,
  path: string,
): Promise<Uint8Array> {
  const snapshot = new Uint8Array(PREVIEW_MAX_BYTES + 1);
  const reader = stream.getReader();
  let size = 0;
  let completed = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        completed = true;
        return snapshot.subarray(0, size);
      }
      const take = Math.min(chunk.value.byteLength, snapshot.byteLength - size);
      snapshot.set(chunk.value.subarray(0, take), size);
      size += take;
      if (size > PREVIEW_MAX_BYTES) {
        throw previewError("preview_too_large", path, size);
      }
    }
  } finally {
    try {
      if (!completed) await reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  }
}
