import { AccountSection } from "./account-section";
import { InstructionsSection } from "./instructions-section";
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
    id: "account",
    title: "Аккаунт",
    description: "Ваш профиль Telegram",
    Component: AccountSection,
  },
];
