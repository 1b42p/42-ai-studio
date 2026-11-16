import { defineMemory } from "eve/memory";

import { getSettings } from "@/lib/settings/service";

import { userMemoryProvider } from "./lib/user-memory";

export default defineMemory({
  namespace: "studio-memory-v1",
  description: "Долговременная память о пользователе: устойчивые предпочтения и факты (язык, голос, формат и стиль роликов, привычки). Не сохраняй пароли, ключи, платёжные данные, одноразовые коды и содержимое документов пользователя.",
  provider: userMemoryProvider(),
  async scope({ session }) {
    const principal = session.auth.current ?? session.auth.initiator;
    if (principal?.principalType !== "user" || principal.authenticator !== "studio") return null;
    const settings = await getSettings(principal.principalId);
    return settings.memoryEnabled ? ["user", principal.principalId] : null;
  },
});
