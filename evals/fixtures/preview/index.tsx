import React from "react";
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame, useVideoConfig } from "remotion";

function Coffee() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scene = Math.min(2, Math.floor(frame / (durationInFrames / 3)));
  return <AbsoluteFill style={{ background: "#f5eee2", color: "#3a251c", fontFamily: "DejaVu Sans, sans-serif" }}>
    <div style={{ position: "absolute", left: 160, top: 180, width: 1600, fontWeight: 700, fontSize: 152, lineHeight: 1.2 }}>{["Кофе начинается с зерна", "Время заварить", "Насладитесь моментом"][scene]}</div>
    <div style={{ position: "absolute", left: 160, top: 590, width: 1100, fontSize: 80, lineHeight: 1.2 }}>{["Аромат раскрывается в каждой детали.", "Свежий помол, горячая вода и немного терпения.", "Пауза для себя — прежде чем начнётся день."][scene]}</div>
    <svg width="420" height="420" viewBox="0 0 700 700" style={{ position: "absolute", right: 160, top: 470 }}>
      {scene === 0 ? <g transform="rotate(-25 350 350)"><ellipse cx="350" cy="340" rx="170" ry="240" fill="#70442e" /><path d="M350 110 C230 250 465 400 350 570" stroke="#f5eee2" strokeWidth="24" fill="none" /></g> : <g>
        <path d="M130 260 H490 V420 Q490 530 380 530 H240 Q130 530 130 420 Z" fill="#b6673f" />
        <path d="M490 290 H540 Q640 290 600 410 Q580 460 490 440" stroke="#70442e" strokeWidth="30" fill="none" />
        <ellipse cx="310" cy="260" rx="180" ry="40" fill="#70442e" />
        <ellipse cx="320" cy="560" rx="260" ry="26" fill="#e1cfb6" />
        <g stroke="#bfa284" strokeWidth="18" fill="none" strokeLinecap="round"><path d="M240 190 Q200 150 240 110 Q280 70 240 30" /><path d="M350 190 Q310 150 350 110 Q390 70 350 30" /></g>
        {scene === 1 ? <path d="M320 10 L320 210" stroke="#70442e" strokeWidth="18" /> : null}
      </g>}
    </svg>
  </AbsoluteFill>;
}

const Root = () => <Composition id="Main" component={Coffee} defaultProps={{ seconds: 30 }} durationInFrames={900} calculateMetadata={({ props }) => ({ durationInFrames: props.seconds * 30 })} fps={30} width={1920} height={1080} />;
registerRoot(Root);
