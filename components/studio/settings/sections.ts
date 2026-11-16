import { AccountSection } from "./account-section";
import { InstructionsSection } from "./instructions-section";
import { McpSection } from "./mcp-section";
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
      "Агент учитывает их в каждом сообщении во всех ваших сессиях: стиль, язык, привычки. Изменения действуют со следующего сообщения.",
    Component: InstructionsSection,
  },
  {
    id: "mcp",
    title: "MCP-серверы",
    description: "Подключите свои MCP-серверы: агент сможет пользоваться их инструментами без подтверждений. Сервер должен быть доступен из интернета. Изменения действуют со следующего сообщения.",
    Component: McpSection,
  },
  {
    id: "account",
    title: "Аккаунт",
    description: "Ваш профиль Telegram",
    Component: AccountSection,
  },
];
