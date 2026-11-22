import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Reach } from "./reach";

// Reference layout for a 1920×1080 shot. Subtitles in a voiced video come
// from the actual words.json rather than the demonstration captions here.
export function ReachScene({ cueMs = 1000 }: { cueMs?: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = frame / fps - cueMs / 1000;

  return (
    <AbsoluteFill style={{ background: "#f8faf4", color: "#203c31", fontFamily: "sans-serif" }}>
      <div style={{
        position: "absolute", top: 200, left: 160, width: 890, height: 330,
        fontWeight: 800, fontSize: 152, lineHeight: "160px",
      }}>
        Мягкое<br />утро
      </div>
      <div style={{ position: "absolute", top: 120, right: 148, width: 620, height: 620 }}>
        <Reach cueMs={cueMs} />
      </div>
      <div style={{
        position: "absolute", bottom: 185, left: 184, width: 1552, height: 185,
        borderRadius: 30, background: "#203c31", color: "#fff", display: "grid",
        placeItems: "center", fontWeight: 650, fontSize: 80,
      }}>
        {elapsed < 0 ? "Встаньте прямо" : elapsed < 1.55 ? "Потянитесь вверх" : "Опустите руки"}
      </div>
    </AbsoluteFill>
  );
}
