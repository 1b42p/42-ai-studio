import React from "react";

/** Shared by the recorded frames and the Remotion fixture project. */
export function Coffee({ scene, frame, title = "Кофе начинается с зерна" }: { scene: number; frame: number; title?: string }) {
  const labels = [title, "Время заварить", "Насладитесь моментом"];
  return <div style={{ width: 1920, height: 1080, position: "relative", overflow: "hidden", background: "#f5eee2", color: "#3a251c", fontFamily: "DejaVu Sans, sans-serif" }}>
    <div style={{ position: "absolute", left: 120, top: 84, fontSize: 30, letterSpacing: 8 }}>КОФЕ • УТРЕННИЙ РИТУАЛ</div>
    <div style={{ position: "absolute", left: 120, top: 250, width: 900, fontWeight: 700, fontSize: 106, lineHeight: 1.15 }}>{labels[scene]}</div>
    <div style={{ position: "absolute", left: 120, top: 650, width: 850, fontSize: 42, lineHeight: 1.4 }}>{["Аромат раскрывается в каждой детали.", "Свежий помол, горячая вода и немного терпения.", "Пауза для себя — прежде чем начнётся день."][scene]}</div>
    <svg width="700" height="700" viewBox="0 0 700 700" style={{ position: "absolute", right: 60, top: 230 }}>
      {scene === 0 ? <g transform="rotate(-25 350 350)"><ellipse cx="350" cy="340" rx="170" ry="240" fill="#70442e"/><path d="M350 110 C230 250 465 400 350 570" stroke="#f5eee2" strokeWidth="24" fill="none"/></g> : <g>
        <path d="M130 260 H490 V420 Q490 530 380 530 H240 Q130 530 130 420 Z" fill="#b6673f"/>
        <path d="M490 290 H540 Q640 290 600 410 Q580 460 490 440" stroke="#70442e" strokeWidth="30" fill="none"/>
        <ellipse cx="310" cy="260" rx="180" ry="40" fill="#70442e"/>
        <ellipse cx="320" cy="560" rx="260" ry="26" fill="#e1cfb6"/>
        <g transform={`translate(0, ${Math.sin(frame / 15) * 12})`} stroke="#bfa284" strokeWidth="18" fill="none" strokeLinecap="round">
          <path d="M240 190 Q200 150 240 110 Q280 70 240 30"/><path d="M350 190 Q310 150 350 110 Q390 70 350 30"/>
        </g>
        {scene === 1 ? <path d="M320 10 L320 210" stroke="#70442e" strokeWidth="18"/> : null}
      </g>}
    </svg>
    <div style={{ position: "absolute", bottom: 76, left: 120, fontSize: 30 }}>42 AI STUDIO</div>
  </div>;
}
