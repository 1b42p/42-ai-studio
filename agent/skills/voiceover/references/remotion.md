# Сцены, звук и субтитры

Прочитай `remotion-markup/voiceover.md`, `calculate-metadata.md`,
`remotion-multimedia/get-audio-duration.md` и
`remotion-captions/display-captions.md` из соседних навыков. Здесь вместо
ElevenLabs используется `speak` либо Piper: ключи ElevenLabs не нужны.
Тайминги уже есть в `.words.json`; транскрибация Whisper не нужна.

## Длительность

Сохрани для каждой сцены путь аудио, данные `.words.json` и текст.
Загружай JSON в `calculateMetadata` через `fetch(staticFile(...))`, учитывая
`abortSignal`; верни вычисленные сцены в `props` и их сумму в
`durationInFrames`. Используй один `fps`, совпадающий с `<Composition>`.

```ts
const audioOffsetFrames = 10;
const durationInFrames = Math.ceil(
  audioOffsetFrames + timings.durationMs / 1000 * fps + 0.5 * fps,
);
```

Если длительности нет в JSON, измерь файл функцией `getAudioDuration` из
`remotion-multimedia`. Сохрани её в метаданных сцены. Не оценивай итоговую
длительность числом слов и не обрезай озвучку под предварительный план.
Сократить ролик можно сокращением текста с повторным синтезом.

Сцены идут последовательно без перекрытия речи. `from` сцены — сумма
длительностей предыдущих сцен; начало и конец в `NOTES.md` абсолютные.
Внутри `<Sequence from={scene.from} durationInFrames={scene.durationInFrames}>`
звук начинается вложенной `<Sequence from={10}>`:

```tsx
import {Audio} from '@remotion/media';
import {Sequence, staticFile} from 'remotion';

<Sequence from={scene.from} durationInFrames={scene.durationInFrames}>
  <SceneVisual />
  <Sequence from={10} layout="none">
    <Audio src={staticFile(scene.audioFile)} />
  </Sequence>
  <SceneCaptions captions={scene.captions} />
</Sequence>
```

`audioFile` считается от `public/` (`voice/scene-01.mp3` либо `.wav`),
а не от `/workspace/`. Не сдвигай и звук, и родительскую сцену на те же 10 кадров.

## Тайминги Caption

Для каждой сцены отдельно переведи `words[]` в `Caption[]`.
Отсчёт — локальное время сцены, начало аудио уже включено:

```ts
import {createTikTokStyleCaptions, type Caption} from '@remotion/captions';

const offsetMs = 10 / fps * 1000;
const captions: Caption[] = timings.words.map((word, index) => ({
  text: (index === 0 ? '' : ' ') + word.text,
  startMs: word.startMs + offsetMs,
  endMs: word.endMs + offsetMs,
  timestampMs: (word.startMs + word.endMs) / 2 + offsetMs,
  confidence: null,
}));
const {pages} = createTikTokStyleCaptions({
  captions,
  combineTokensWithinMilliseconds: 1000,
  breakOnSilenceAfterMilliseconds: 300,
});
```

Параметр пауз есть с Remotion 4.0.514, в образе 4.0.538 он доступен.
Общий список страниц на весь ролик склеивает разные сцены — каждая сцена
получает свои captions и pages внутри своего `Sequence`.
Переменные и JSON подходят: требование официального руководства о литерале
массива нужно только редактору Studio, здесь оно не применяется.

## Собственный компонент

Прочитай серверным `read_page` исходник
https://www.remotion.dev/elements/captions/basic-captions.md как пример
выбора страницы. Напиши свой компонент: готовый Basic Captions по умолчанию
группирует по 3000 мс, не принимает готовые страницы, не пробрасывает
`breakOnSilenceAfterMilliseconds` и не выделяет произносимое слово.

В компоненте, который находится прямо внутри Sequence сцены:

```tsx
const frame = useCurrentFrame();
const {fps} = useVideoConfig();
const t = frame / fps * 1000;
const page = pages.find((p) => p.startMs <= t && t < p.startMs + p.durationMs);
// Для каждого token:
const active = token.fromMs <= t && t < token.toMs;
```

`tokens[].fromMs/toMs` уже абсолютны относительно сцены: `page.startMs`
к ним повторно не прибавляется. Страницу показывай в её интервале;
внутри страницы подсвечивай только активное слово. Каждый token открывай
при `t >= token.fromMs`, заранее оставляя
его место невидимым, чтобы строка не прыгала. Допуск появления и подсветки
по `startMs` — ±150 мс. В паузе предыдущая страница может оставаться:
`durationMs` по API тянется до начала следующей страницы, но активного слова нет.

Контейнеру текста задай `whiteSpace: 'pre'`; переносы вноси явно `\n`.
Перед рендером разбей текст страницы по ширине в том же шрифте
(`measureText` из установленного `@remotion/layout-utils`, после загрузки
шрифта), сохранив порядок и время tokens. `measureText` работает только
в браузере: вычисляй переносы в компоненте, не в Node.js и не в
`calculateMetadata`. На странице максимум две строки.
Если третья нужна даже при минимальном размере, вставь `pageBreakAfter: true`
в исходный Caption перед переполнением и построй страницы заново теми же
параметрами. Не уменьшай шрифт ниже нормы и не скрывай лишний текст.
Одиночное слишком длинное слово требует другой компоновки или согласованной
правки текста с повторной озвучкой, а не обрезки.

Для ширины 1080: боковые отступы не меньше 80 px, сверху и снизу 100 px,
текст не меньше 44 px. Масштабируй на ширину композиции / 1080 по
`frame-review`. Подложка или обводка обязательны для читаемого контраста;
текущее слово выделяй цветом. Проверяй все страницы расчётом ширины и
опорными кадрами; для проверки выбери самую длинную страницу и границу фраз.

## Готовый ролик

После `frame-review` и полного рендера проверь файл:

```sh
npx remotion ffprobe -v error -show_entries stream=codec_type,duration:format=duration -of json out/<имя>.mp4
```

Аудиодорожка обязательна; её длительность не короче видео минус 100 мс.
При `N/A` в потоке получи длительность аудио по последнему пакету
(`-select_streams a:0 -show_packets`), а не подменяй её общей длительностью.
Конец исходного аудио последней сцены в секундах:
`lastScene.from / fps + 10 / fps + lastTimings.durationMs / 1000`.
Видео должно заканчиваться через 0,5 с после этой точки с допуском ±100 мс
(округление формулы не больше кадра). Не путай конец речи с концом
дополненной тишиной дорожки. Проверь три начала слов на кадрах по таймингам;
при сомнении извлеки отрезки аудио `npx remotion ffmpeg` и сравни с кадрами.

Справка: [Caption](https://www.remotion.dev/docs/captions/caption),
[страницы](https://www.remotion.dev/docs/captions/create-tiktok-style-captions),
[Audio](https://www.remotion.dev/docs/media/audio).
