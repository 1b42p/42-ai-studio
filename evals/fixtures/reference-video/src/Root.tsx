import { AbsoluteFill, Composition, interpolate, Sequence, useCurrentFrame } from "remotion";

/**
 * Эталон: 30 с, 1920×1080, 30 к/с, три сцены по 10 с.
 * Рендер в шаблонном проекте: скопировать src поверх /opt/remotion и выполнить
 * npx remotion render src/index.ts Reference out/reference.mp4
 */
const Scene = ({ title, from, to }: { title: string; from: string; to: string }) => {
  const frame = useCurrentFrame();
  const shift = interpolate(frame, [0, 300], [48, -48]);

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${from} 0%, ${to} 100%)`,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          color: "white",
          filter: "blur(1.5px)",
          fontFamily: "DejaVu Sans, Liberation Sans, sans-serif",
          fontSize: 120,
          fontWeight: 700,
          textShadow: "0 12px 28px rgba(0, 0, 0, 0.55)",
          transform: `translateY(${shift}px)`,
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};

const Reference = () => {
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={300}>
        <Scene title="Первая" from="#1e3a8a" to="#7c3aed" />
      </Sequence>
      <Sequence from={300} durationInFrames={300}>
        <Scene title="Вторая" from="#0f766e" to="#0369a1" />
      </Sequence>
      <Sequence from={600} durationInFrames={300}>
        <Scene title="Третья" from="#9a3412" to="#be123c" />
      </Sequence>
    </AbsoluteFill>
  );
};

export const RemotionRoot = () => {
  return (
    <Composition
      id="Reference"
      component={Reference}
      durationInFrames={900}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
