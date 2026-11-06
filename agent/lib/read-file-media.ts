import type { ReadFileToolOutput } from "eve/tools/read_file";

import {
  publishToolMedia,
  PublishToolMediaError,
  type PublishToolMediaContext,
  type PublishToolMediaDependencies,
} from "@/lib/media/publish-tool-media";

export interface ReadFileMediaOutput extends ReadFileToolOutput {
  readonly media?: { readonly imageId: string };
}

/** Публикация для чата не должна лишать модель успешно прочитанного кадра. */
export async function publishReadFileImage(
  output: ReadFileToolOutput,
  ctx: PublishToolMediaContext,
  dependencies: PublishToolMediaDependencies = {},
): Promise<ReadFileMediaOutput> {
  if (!output.file?.mediaType.startsWith("image/")) return output;
  try {
    const { mediaId } = await publishToolMedia(ctx, {
      path: output.path,
      contentType: output.file.mediaType,
    }, dependencies);
    return { ...output, media: { imageId: mediaId } };
  } catch (error) {
    // Не журналируем исходное исключение: драйверы могут включать секреты.
    console.warn("[read_file:media] Кадр не сохранён:",
      error instanceof PublishToolMediaError ? error.reason : "publish_failed");
    return output;
  }
}
