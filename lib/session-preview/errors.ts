export type PreviewErrorCode =
  | "preview_no_session"
  | "preview_bad_path"
  | "preview_not_found"
  | "preview_not_image"
  | "preview_too_large";

export function previewError(code: PreviewErrorCode, path = "", size = 0): Error {
  const messages: Record<PreviewErrorCode, string> = {
    preview_no_session: "Не удалось определить сессию для превью.",
    preview_bad_path: `Путь «${path}» выходит за пределы рабочей области.`,
    preview_not_found: `Файл «${path}» не найден в песочнице.`,
    preview_not_image: `Файл «${path}» не является картинкой PNG, JPEG или WebP.`,
    preview_too_large: `Картинка больше 1 МиБ (${size}). Отрендерите кадр в JPEG меньшего размера: \`--scale=0.5\` или \`--jpeg-quality=80\`.`,
  };
  return new Error(`${code}: ${messages[code]}`);
}
