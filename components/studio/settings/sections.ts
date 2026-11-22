import { AccountSection } from "./account-section";
import { InstructionsSection } from "./instructions-section";
import { McpSection } from "./mcp-section";
import { MemorySection } from "./memory-section";
import type { SettingsSection } from "./section";
import { ThemeSection } from "./theme-section";

export const settingsSections: readonly SettingsSection[] = [
  {
    id: "theme",
    title: "Тема",
    description: "Оформление сайта на этом устройстве",
    Component: ThemeSection,
  },
  {
    id: "instructions",
    title: "Общие указания для агента",
    description:
      "Стиль, язык и другие предпочтения для всех ваших сессий. Агент применит изменения к следующему запросу после завершения текущего ответа.",
    Component: InstructionsSection,
  },
  {
    id: "memory",
    title: "Память",
    description:
      "Агент запоминает ваши постоянные предпочтения и использует их во всех ваших сессиях. Выключенная память не используется, но остаётся сохранённой. Просмотреть или очистить её нельзя.",
    Component: MemorySection,
  },
  {
    id: "mcp",
    title: "MCP-серверы",
    description: "Агент может пользоваться инструментами ваших MCP-серверов без подтверждений. Сервер должен быть доступен из интернета. Новые подключения станут доступны после завершения текущего ответа.",
    Component: McpSection,
  },
  {
    id: "account",
    title: "Аккаунт",
    description: "Ваш профиль Telegram",
    Component: AccountSection,
  },
];
