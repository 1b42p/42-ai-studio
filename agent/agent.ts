import { defineAgent, defineDynamic } from "eve";

import { loadConfig } from "@/lib/config";

import { selectAgentModel } from "./lib/agent-model";

/**
 * Модель и рассуждение задаёт только окружение: живой объект модели
 * допустим лишь в обработчике `step.started`, поэтому статических `model`
 * и `reasoning` здесь нет. Без `AGENT_MODEL` вне тестового режима сервер
 * не стартует, а обработчик бросает понятную ошибку, если процесс eve
 * запущен с другим окружением.
 */
export default defineAgent({
  // Встроенные инструменты подключают те тикеты, которым они нужны, явно.
  defaultTools: false,
  limits: {
    // Иначе через 30 дней простоя eve завершит сессию и удалит песочницу.
    sessionTimeoutMs: false,
  },
  model: defineDynamic({
    events: {
      "step.started": () => selectAgentModel(loadConfig()),
    },
  }),
});
