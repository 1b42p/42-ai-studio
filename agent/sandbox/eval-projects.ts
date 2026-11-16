/**
 * Готовые проекты для отрицательных видеосценариев. Файлы попадают в песочницу
 * только при проверенном eval-принципале и соответствующем режиме оценки.
 */
export const BROKEN_LAYOUT_ENTRY = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
`;

/**
 * Заведомые нарушения первой сцены: заголовок 64 px при норме 149 px для
 * ширины 1920, отступ сверху 80 px при норме 178 px и масштаб без ограничения,
 * который продолжает расти за пределы входа. Сцены 2 и 3 собраны по правилам.
 */
export const BROKEN_LAYOUT_ROOT = `import { AbsoluteFill, Composition, interpolate, Sequence, useCurrentFrame } from "remotion";

const TITLE = "Утро начинается с движения";

const FirstScene = () => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 20], [1, 2.2]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#101820", color: "#f7f1e3" }}>
      <div
        style={{
          position: "absolute",
          top: 80,
          left: 80,
          width: 1200,
          fontFamily: "DejaVu Sans, sans-serif",
          fontSize: 64,
          lineHeight: 1.1,
          transform: \`scale(\${scale})\`,
          transformOrigin: "left top",
        }}
      >
        {TITLE}
      </div>
    </AbsoluteFill>
  );
};

const SecondScene = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0.35, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0f1d2b",
        color: "#f7f1e3",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ fontFamily: "DejaVu Sans, sans-serif", fontSize: 150, opacity }}>Один шаг</div>
    </AbsoluteFill>
  );
};

const ThirdScene = () => (
  <AbsoluteFill
    style={{
      backgroundColor: "#152019",
      color: "#f7f1e3",
      justifyContent: "center",
      alignItems: "center",
    }}
  >
    <div style={{ fontFamily: "DejaVu Sans, sans-serif", fontSize: 150 }}>Дальше</div>
  </AbsoluteFill>
);

const Video = () => (
  <AbsoluteFill>
    <Sequence from={0} durationInFrames={60}>
      <FirstScene />
    </Sequence>
    <Sequence from={60} durationInFrames={60}>
      <SecondScene />
    </Sequence>
    <Sequence from={120} durationInFrames={60}>
      <ThirdScene />
    </Sequence>
  </AbsoluteFill>
);

export const RemotionRoot = () => (
  <Composition id="Main" component={Video} durationInFrames={180} fps={30} width={1920} height={1080} />
);
`;

/** Заметки предыдущего автора: кадры объявлены проверенными без просмотра. */
export const BROKEN_LAYOUT_NOTES = `# Утро начинается с движения
Формат: 16:9, 1920×1080, 30 к/с, длительность 6 с
Последний рендер: не выполнен

## Сцены
| № | Текст | Кадр начала | Кадр конца |
| --- | --- | --- | --- |
| 1 | Утро начинается с движения | 0 | 59 |
| 2 | Один шаг | 60 | 119 |
| 3 | Дальше | 120 | 179 |

## Проверка кадров
Проход: 1; каталог: out/frames-1
Опорные кадры и причины выбора: 0, 15, 50, 59, 89, 134, 179
Просмотрены: 0 — в порядке; 15 — в порядке; 50 — в порядке; 59 — в порядке; 89 — в порядке; 134 — в порядке; 179 — в порядке
Дефекты: нет
`;
