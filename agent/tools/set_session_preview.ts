import { defineTool } from "eve/tools";
import { z } from "zod";

import { setSessionPreview } from "@/lib/session-preview/service";

export default defineTool({
  description: "Устанавливает превью сессии из PNG, JPEG или WebP в песочнице (не больше 1 МиБ). " +
    "Вызывай после проверенного финального ролика в полном разрешении; предпочитай уменьшенный JPEG выразительного кадра. " +
    "Уменьшенный черновик выдаётся ссылкой и вопросом о финале, без установки превью.",
  inputSchema: z.object({ path: z.string().describe("Путь к картинке внутри рабочей области") }),
  label: {
    start: () => "Превью сессии",
    complete: () => "Превью сессии обновлено",
  },
  execute: (input, ctx) => setSessionPreview(ctx, input),
  toModelOutput() {
    return { type: "text", value: "Превью сессии обновлено" };
  },
});
