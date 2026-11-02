import { EditFileError } from "./errors";
import { EDIT_FILE_MAX_BYTES } from "./apply";

export type LimitedRead =
  | { readonly kind: "missing" }
  | { readonly kind: "text"; readonly text: string };

function isDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EISDIR";
}

/**
 * Читает файл потоком и обрывается на `(maxBytes + 1)`-м байте, чтобы не
 * тащить в память большие бинарники. Каталог — `is_directory`, отсутствие —
 * `missing`, сверх лимита — `too_large`, не UTF-8 — `not_text`.
 */
export async function readTextFileLimited(
  sandbox: {
    readFile(options: {
      path: string;
      abortSignal?: AbortSignal;
    }): Promise<ReadableStream<Uint8Array> | null>;
  },
  path: string,
  options: { readonly abortSignal?: AbortSignal; readonly maxBytes?: number } = {},
): Promise<LimitedRead> {
  const maxBytes = options.maxBytes ?? EDIT_FILE_MAX_BYTES;
  let stream: ReadableStream<Uint8Array> | null;
  try {
    stream = await sandbox.readFile({ path, abortSignal: options.abortSignal });
  } catch (error) {
    if (isDirectoryError(error)) throw new EditFileError("is_directory", path);
    throw error;
  }
  if (stream === null) return { kind: "missing" };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      options.abortSignal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new EditFileError("too_large", path);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EditFileError) throw error;
    if (isDirectoryError(error)) throw new EditFileError("is_directory", path);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    throw new EditFileError("not_text", path);
  }
}
