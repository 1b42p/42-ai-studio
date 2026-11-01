import { defineHook } from "eve/hooks";

import { createPersistEventHandler } from "../lib/persist-hook";

/** Все события корневой сессии: привязка, проверка владельца и сохранение. */
export default defineHook({
  events: {
    "*": createPersistEventHandler(),
  },
});
