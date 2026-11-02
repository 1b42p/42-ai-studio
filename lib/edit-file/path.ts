import { EditFileError } from "./errors";

/**
 * Отклоняет пустой путь и `$HOME/…` до разрешения в песочнице.
 * Остальные пути принимает как есть: абсолютные проходят, относительные
 * резолвит вызывающий через `sandbox.resolvePath`.
 */
export function assertEditFilePath(filePath: string): void {
  const trimmed = filePath.trim();
  if (trimmed.length === 0 || trimmed === "$HOME" || trimmed.startsWith("$HOME/")) {
    throw new EditFileError("bad_path");
  }
}
