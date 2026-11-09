import { readFileSync } from "node:fs";
import type { EveEvalContext, ToolStub } from "eve/evals";

import data from "../fixtures/voiceover/project.json";
import { blockedRead, emptySearch, page, webSession } from "../web/fixtures";
import { mediaStubs } from "./command-fixtures";
import {
  escapePattern,
  FRAME_NAMES,
  PROJECT,
  readResponse,
  REVIEW_FRAMES,
  SCENES,
  sceneBase,
  VOICE,
  workspacePathForms,
} from "./fixture-data";
import { voiceoverFrameOutputs } from "./media-fixture";

export {
  fixtureTimings,
  FRAME_NAMES,
  framePaths,
  PIPER_VOICE,
  PROJECT,
  REVIEW_FRAMES,
  SCENES,
  VOICE,
  VOICEOVER_TIMEOUT_MS,
} from "./fixture-data";

export const VOICEOVER_REQUEST = [
  "Сделай готовый горизонтальный ролик 16:9, 1920×1080, 30 кадров/с, примерно на восемнадцать секунд о спокойном начале утра для взрослых.",
  `Проект ${PROJECT} уже содержит утверждённую графику трёх сцен и компонент субтитров.`,
  "Исходники src, оформление и тексты утверждены: не меняй их и не создавай проект заново.",
  "Тексты UTF-8 уже сохранены в voice/scene-01.txt, scene-02.txt и scene-03.txt; используй их без изменений.",
  `Аудиофайлов ещё нет. Нужна русская озвучка Светланой (${VOICE}), обычная скорость, без музыки.`,
  "Длительность подстрой под фактическую речь. Точные тексты по сценам:",
  ...SCENES.map((text, index) => `${index + 1}. ${text}`),
  "Основная озвучка: public/voice/scene-01, scene-02, scene-03 без расширения.",
  "Если Светлана недоступна, можно использовать другой русский голос для всех сцен; для Piper используй отдельные имена scene-01-piper, scene-02-piper, scene-03-piper.",
  "Шаблон сам загружает JSON, выбирает MP3/WAV и считает длительности через calculateMetadata.",
  "Проверь подсветку произносимых слов и не больше двух строк субтитров.",
  `Контрольные кадры ${REVIEW_FRAMES.join(", ")} сохрани в out/frames-1: среди них есть начала всех сцен, длинная страница субтитров и границы фраз.`,
  "Готовый файл сохрани в out/calm-morning.mp4. Дополнительных пожеланий нет.",
].join("\n");

const REFERENCE_FILES = [
  "voiceover/references/remotion.md",
  "voiceover/references/piper.md",
  "voiceover/scripts/piper_speak.py",
  "frame-review/references/notes-template.md",
  "frame-review/scripts/check-frames.py",
  "remotion-create/video-layout.md",
  "remotion-captions/display-captions.md",
  "remotion-markup/voiceover.md",
  "remotion-markup/calculate-metadata.md",
  "remotion-markup/compositions.md",
  "remotion-markup/multi-scene-video.md",
  "remotion-markup/sequencing.md",
  "remotion-markup/measuring-text.md",
  "remotion-markup/local-fonts.md",
  "remotion-multimedia/get-audio-duration.md",
  "remotion-interactivity/timeline-structure.md",
];

const notes = [
  "# Спокойное утро",
  "",
  "Утверждены три сцены и их оформление.",
  `Композиция ${data.composition}, ${data.width}×${data.height}, ${data.fps} кадров/с.`,
  `Проход: 1. Контрольные кадры: ${REVIEW_FRAMES.join(", ")}.`,
  ...SCENES.map((text, index) => `Сцена ${index + 1}: ${text}`),
].join("\n");

const plannedNotes = [
  notes,
  "",
  "Таблица сцен: 0–180, 181–367, 368–545.",
  "Звук с десятого кадра каждой сцены; после исходного аудио пауза 0,5 с.",
  "Самая длинная страница субтитров и границы фраз включены в контрольную выборку.",
  "",
].join("\n");

function notesEdit(previous: string, next: string) {
  const lineDifference = next.split("\n").length - previous.split("\n").length;

  return {
    response: {
      path: `${PROJECT}/NOTES.md`,
      created: false,
      replacements: 1,
      oldContent: previous,
      newContent: next,
      linesAdded: Math.max(0, lineDifference),
      linesRemoved: Math.max(0, -lineDifference),
    },
  };
}

function referenceStubs(): ToolStub[] {
  return REFERENCE_FILES.map((path, index) => ({
    id: `reference-${index}`,
    tool: "read_file",
    match: { filePath: { pattern: `(?:^|/)skills/${escapePattern(path)}$` } },
    outcome: {
      response: readResponse(
        `/root/.agents/skills/${path}`,
        readFileSync(`agent/skills/${path}`, "utf8"),
      ),
    },
  }));
}

function projectStubs(): ToolStub[] {
  const files: ToolStub[] = Object.entries(data.files).map(
    ([path, content], index) => ({
      id: `project-file-${index}`,
      tool: "read_file",
      match: { filePath: { enum: workspacePathForms(`${PROJECT}/${path}`) } },
      outcome: { response: readResponse(`${PROJECT}/${path}`, content) },
    }),
  );
  const frames: ToolStub[] = voiceoverFrameOutputs.map((output, index) => ({
    id: `review-frame-${index}`,
    tool: "read_file",
    match: {
      filePath: {
        pattern: `${escapePattern(`out/frames-1/${FRAME_NAMES[index]}`)}$`,
      },
    },
    outcome: { response: output },
  }));

  return [
    ...files,
    {
      id: "project-notes",
      tool: "read_file",
      match: { filePath: { pattern: "(?:^|/)NOTES\\.md$" } },
      outcome: { response: readResponse(`${PROJECT}/NOTES.md`, plannedNotes) },
    },
    ...frames,
    {
      id: "notes-edit",
      tool: "edit_file",
      match: { filePath: { pattern: "(?:^|/)NOTES\\.md$" } },
      outcome: notesEdit(notes, plannedNotes),
    },
    {
      id: "unexpected-edit",
      tool: "edit_file",
      outcome: {
        throw: {
          message:
            "Утверждённые исходники и оформление этого проекта менять не нужно. Добавьте озвучку и выполните проверку.",
        },
      },
    },
  ];
}

function speechStubs(fallback: boolean): ToolStub[] {
  if (fallback) {
    return [
      {
        id: "speech-unavailable",
        tool: "speak",
        outcome: {
          throw: {
            message:
              "speak_unavailable: Сервис озвучки сейчас недоступен (после трёх попыток).",
          },
        },
      },
    ];
  }

  return SCENES.map((text, index) => ({
    id: `speech-${index}`,
    tool: "speak",
    match: {
      text: { const: text },
      voice: { const: VOICE },
      outputPath: { enum: workspacePathForms(sceneBase(index, false)) },
    },
    outcome: {
      response: {
        audioPath: `${sceneBase(index, false)}.mp3`,
        timingsPath: `${sceneBase(index, false)}.words.json`,
        voice: VOICE,
        language: "ru-RU",
        format: "mp3",
        durationMs: data.scenes[index].durationMs,
        wordCount: data.scenes[index].words.length,
        text,
        media: { audioId: `00000000-0000-4000-8000-00000000000${index + 1}` },
      },
    },
  }));
}

function documentationStubs(): ToolStub[] {
  return [
    {
      id: "basic-caption-source",
      tool: "read_page",
      match: {
        url: {
          pattern:
            "^https://www\\.remotion\\.dev/elements/captions/basic-captions(?:/|\\.md|$)",
        },
      },
      outcome: {
        response: page(
          "https://www.remotion.dev/elements/captions/basic-captions.md",
          "Basic Captions",
          readFileSync("evals/fixtures/voiceover/basic-captions.md", "utf8"),
          "en",
        ),
      },
    },
    {
      id: "caption-docs",
      tool: "read_page",
      match: {
        url: { pattern: "^https://www\\.remotion\\.dev/docs/captions" },
      },
      outcome: {
        response: page(
          "https://www.remotion.dev/docs/captions/create-tiktok-style-captions",
          "Captions",
          "createTikTokStyleCaptions accepts captions, combineTokensWithinMilliseconds: 1000 and breakOnSilenceAfterMilliseconds: 300. Each page has startMs, durationMs and tokens with fromMs/toMs. Basic Captions uses 3000 by default; the project's Captions component highlights individual words.",
          "en",
        ),
      },
    },
  ];
}

export async function voiceoverSession(t: EveEvalContext, fallback: boolean) {
  const stubs: ToolStub[] = [
    ...referenceStubs(),
    ...projectStubs(),
    ...mediaStubs(fallback),
    ...speechStubs(fallback),
    // При запасном пути speak и так недоступен целиком: вторая безусловная
    // подмена не срабатывает и не помещается в предел в 100 подмен.
    ...(fallback
      ? []
      : [{
          id: "unexpected-speech",
          tool: "speak",
          outcome: {
            throw: {
              message:
                "speak_bad_input: Укажите утверждённый текст сцены, голос ru-RU-SvetlanaNeural и путь calm-morning/public/voice/scene-NN без расширения. Абсолютный путь от /workspace также допустим.",
            },
          },
        }]),
    {
      id: "voices",
      tool: "list_voices",
      outcome: {
        response: {
          voices: [
            {
              name: VOICE,
              locale: "ru-RU",
              gender: "Female",
              displayName: "Светлана",
              multilingual: false,
            },
          ],
        },
      },
    },
    ...documentationStubs(),
    {
      id: "unknown-read",
      tool: "read_file",
      outcome: {
        throw: { message: "Файл отсутствует в утверждённом проекте." },
      },
    },
    {
      id: "unsupported-command",
      tool: "bash",
      outcome: {
        throw: {
          message:
            "Команда не поддержана записанным контрактом этого проекта. Успех выполнения не подтверждён.",
        },
      },
    },
    blockedRead,
    emptySearch,
  ];

  return webSession(t, stubs);
}
