import {
  AudioLines,
  Captions,
  ChartNoAxesCombined,
  Clapperboard,
  FileText,
  Link,
  MessageSquare,
  Music2,
} from "lucide-react";

export const heroTitle = "Опишите ролик словами — получите готовое видео";

export const landingSteps = [
  {
    title: "Опишите задачу",
    description: "Напишите, какой ролик нужен: тема, длительность, формат, язык. Приложите файлы, таблицы, презентации или ссылку на статью или видео.",
  },
  {
    title: "Агент уточнит детали",
    description: "Если чего-то не хватает, он задаст короткие вопросы с вариантами ответа.",
  },
  {
    title: "Агент соберёт ролик",
    description: "Напишет анимацию, озвучит текст, сделает субтитры и проверит кадры до финального рендера. Каждое его действие видно в ленте.",
  },
  {
    title: "Получите результат",
    description: "Готовый ролик появится в чате: смотрите, скачивайте, просите правки — например, «сделай заголовок крупнее».",
  },
] as const;

export const landingFeatures = [
  { title: "Озвучка", description: "Русские и английские голоса, мужские и женские.", icon: AudioLines },
  { title: "Субтитры по словам", description: "Текст появляется в момент, когда его произносят.", icon: Captions },
  { title: "Анимация без шаблонов", description: "Графика, схемы, переходы пишутся под вашу задачу с нуля.", icon: Clapperboard },
  { title: "Графики из ваших данных", description: "Приложите таблицу CSV или XLSX — получите анимированные диаграммы.", icon: ChartNoAxesCombined },
  { title: "Презентации и статьи", description: "PDF, PPTX или ссылка на статью превращаются в ролик-пересказ.", icon: FileText },
  { title: "Видео по ссылкам", description: "Кадры и фрагменты из видео на YouTube, Twitch, TikTok и других сайтах можно использовать в ролике.", icon: Link },
  { title: "Фоновая музыка", description: "Агент пишет её кодом, отдельно искать музыку не нужно.", icon: Music2 },
  { title: "Правки репликами", description: "Скажите «замени третью сцену» — получите новую версию в том же проекте.", icon: MessageSquare },
] as const;
