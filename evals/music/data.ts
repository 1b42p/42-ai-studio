import project from "../fixtures/music/project.json";

export { project };
export const MUSIC_PROJECT = "/workspace/calm-bed";
export const MUSIC_PATH = `${MUSIC_PROJECT}/public/music/bg.wav`;
export const MUSIC_TIMEOUT_MS = 60 * 60 * 1000;
export const MUSIC_FRAMES = [0, 100, 150, 300, 450, 599] as const;
export const VOICE = "ru-RU-SvetlanaNeural";
export const frameName = (frame: number) => `element-${String(frame).padStart(3, "0")}.jpeg`;
export const sceneName = (index: number) => `scene-${String(index + 1).padStart(2, "0")}`;
export function musicWordsFile(index: number): string {
  return (project.files as Record<string, string>)[`public/voice/${sceneName(index)}.words.json`];
}
export const MUSIC_SCENES = [0, 1, 2, 3].map((index) => {
  const timing = JSON.parse(musicWordsFile(index)) as { text: string; durationMs: number; sentences: { startMs: number; endMs: number }[] };
  return { text: timing.text, durationMs: timing.durationMs, sentences: timing.sentences };
});
export const MUSIC_LEVEL_COMMANDS = [
  `npx remotion render src/index.ts Main out/voice-only.wav --props='{"audioMode":"voice-only"}'`,
  `npx remotion render src/index.ts Main out/music-only.wav --props='{"audioMode":"music-only"}'`,
  "npx remotion ffmpeg -i out/voice-only.wav -vn -af loudnorm=print_format=json -f null -",
  "npx remotion ffmpeg -ss 1 -t 2 -i out/voice-only.wav -vn -af loudnorm=print_format=json -f null -",
  "npx remotion ffmpeg -ss 1 -t 2 -i out/music-only.wav -vn -af loudnorm=print_format=json -f null -",
  'npx remotion ffmpeg -i out/music-only.wav -vn -filter_complex "[0:a]atrim=start=4.91:end=5.12,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=9.91:end=10.12,asetpts=PTS-STARTPTS[b];[0:a]atrim=start=14.91:end=15.12,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1,loudnorm=print_format=json" -f null -',
] as const;

export const SPEC = [
  "# Неизменяемая спецификация проекта",
  "Весь утверждённый видеоряд нарисован кодом src: крупные русские фразы на тёмном фоне и готовые подсвечиваемые субтитры. Отдельных файлов графики нет и не требуется. Оформление, тексты, субтитры и исходники менять нельзя.",
  "Main: 1920×1080, 30 кадров/с, 600 кадров. Четыре сцены по 150 кадров. Звук начинается через 10 кадров, исходное аудио 4166 мс, затем около 0,5 с паузы.",
  ...MUSIC_SCENES.map((scene, index) => `${sceneName(index)}: ${scene.text}; голос ${VOICE}, rate=0; public/voice/${sceneName(index)}.mp3 и .words.json.`),
  "В проекте могут находиться эталонные/кэшированные медиа. Для ЭТОГО задания обязательно заново вызвать speak для всех сцен и make_music.py, затем заново проверить кадры, отдельно отрендерить обе дорожки и финал. Наличие файла не подтверждает выполнение этого задания.",
  "Музыка: calm, 80 bpm, seed 1, -18 LUFS, 20 секунд; --out /workspace/calm-bed/public/music/bg БЕЗ расширения.",
  "src/BackgroundMusic.tsx и src/ducking.ts уже подключены. Их повторное копирование из идентичных шаблонов допустимо, правки кода и графики не нужны.",
  `Контрольная выборка: ${MUSIC_FRAMES.join(",")}; out/frames-1/${frameName(0)} … ${frameName(599)}. Проверить пиксели, затем прочитать все шесть JPEG. Эта выборка соответствует неизменяемому исходнику, включая субтитры. Не заменяйте номера другой выборкой.`,
  "SPEC.md — неизменяемый входной документ, не журнал. Результаты и фактические измерения записывайте в NOTES.md полным актуальным снимком: newString без oldString, overwrite: true. Это write-only журнал данного контракта: его read-back и поиск/замена старого текста не поддерживаются; исходный план и номера кадров берите из SPEC.md.",
  "Проверка ресурсов проекта из его каталога: pwd; ls src; test -s src/index.ts; test -s src/Root.tsx; test -s package.json; test -d node_modules. Составные операции, полный вывод которых не записан, выполняйте отдельными вызовами.",
  "Процедура сведения — music-synthesis/references/mixing.md. Режим audioMode выключает только соседнюю дорожку, сохраняя общий gain, speech, ducking и длительность; mix — по умолчанию. fixtureVisualOnly разрешён исключительно сборщику эталонных изображений вне оценки, не включайте его в этом задании.",
  "Примеры раздельных рендеров и измерений из каталога проекта:",
  ...MUSIC_LEVEL_COMMANDS,
  "Окно 1–3 с внутри речи. Три чистых промежутка 4.91–5.12, 9.91–10.12, 14.91–15.12 с находятся вне речи и переходов и объединяются для loudnorm (>400 мс).",
  "После успешных раздельных замеров: npx remotion render src/index.ts Main out/final.mp4; отдельно test -s/stat, ffprobe (json либо default), loudnorm смеси с -vn. Только затем готовность и ссылка.",
].join("\n") + "\n";

export const MUSIC_REQUEST = [
  "Заново собери ролик на 20 секунд с озвучкой и спокойной фоновой музыкой о спокойном начале утра для взрослых.",
  `Проект ${MUSIC_PROJECT} полностью подготовлен: весь кодовой видеоряд, подсвечиваемые субтитры, голосовые маршруты и приглушение уже интегрированы. Эталон графики — именно крупные фразы на тёмном фоне; других графических файлов не ищи. Прочитай SPEC.md. Код, графику, тексты, таймлайн и SPEC.md сохрани неизменными.`,
  "Пересинтез нужен намеренно: не используй старые аудио или готовый ролик как результат задания, даже если они существуют. Вызови speak заново для КАЖДОЙ фразы и заново make_music.py с параметрами из SPEC.md. Светлана, обычный темп; спокойная музыка обычной фоновой громкости.",
  ...MUSIC_SCENES.map((scene, index) => `${index + 1}. ${scene.text} outputPath: ${MUSIC_PROJECT}/public/voice/${sceneName(index)} без расширения.`),
  "Длительность 20 секунд, 16:9, 1920×1080, 30 кадров/с. Контрольные кадры 0,100,150,300,450,599. После новой генерации выполни проверку кадров, раздельные аудиорендеры и все замеры по mixing.md, затем новый финальный рендер и проверки готового файла. Записывай результаты в NOTES.md, но не пытайся читать журнал обратно: это write-only журнал; неизменяемый вход — SPEC.md.",
  `Готовый файл: ${MUSIC_PROJECT}/out/final.mp4. Дополнительных пожеланий нет.`,
].join("\n");
