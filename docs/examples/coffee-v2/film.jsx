import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { loadFont } from "@remotion/fonts";
import { CoffeeScene } from "./scene";
import narration from "./narration.json";

loadFont({ family: "Coffee Display", url: staticFile("Oswald-Bold.ttf"), weight: "700" });
loadFont({ family: "Coffee Text", url: staticFile("FiraSans-Regular.ttf"), weight: "400" });

const cream = "#fff1d9";
const orange = "#ffc078";
const speed = 0.85;
const voiceStart = 0.4;
const smooth = Easing.out(Easing.cubic);
const between = (value, start, end, from, to) =>
  interpolate(value, [start, end], [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: smooth,
  });

const captionGroups = [
  ["Хорошее утро", 0, 2],
  ["начинается с кофе.", 2, 5],
  ["А второй кофе —", 5, 8],
  ["в подарок.", 8, 10],
  ["По будням до одиннадцати,", 10, 14],
  ["в кофейне на углу.", 14, 18],
  ["Возьмите кофе для того,", 18, 22],
  ["с кем хочется", 22, 25],
  ["разделить утро.", 25, 27],
].map(([text, first, last]) => ({
  text,
  words: narration.captions.slice(first, last),
  start: narration.captions[first].startMs,
  end: narration.captions[last - 1].endMs + 200,
}));

function Captions() {
  const frame = useCurrentFrame();
  const now = (frame / 30 - voiceStart) * speed * 1000;
  const group = captionGroups.find((entry) => now >= entry.start && now <= entry.end);
  if (!group) return null;
  return (
    <div style={{
      position: "absolute", left: 54, right: 54, bottom: 100,
      textAlign: "center", fontFamily: "Coffee Text", fontSize: 29,
      lineHeight: 1.35, color: cream, textShadow: "0 2px 12px #160c08",
    }}>
      {group.text.split(" ").map((word, index) => {
        const active = group.words[Math.min(index, group.words.length - 1)];
        return <span key={index} style={{
          color: active && now >= active.startMs && now < active.endMs ? orange : cream,
        }}>{index ? " " : ""}{word}</span>;
      })}
    </div>
  );
}

function Copy({ start, end, children, top = 155 }) {
  const time = useCurrentFrame() / 30;
  const enter = between(time, start, start + 0.6, 0, 1);
  const exit = end ? between(time, end - 0.35, end, 1, 0) : 1;
  return (
    <div style={{
      position: "absolute", left: 58, right: 58, top,
      opacity: enter * exit,
      transform: `translateY(${(1 - enter) * 42 - (1 - exit) * 20}px)`,
      fontFamily: "Coffee Display", fontWeight: 700,
      textTransform: "uppercase", lineHeight: 1.06, letterSpacing: -1.6,
      color: cream,
    }}>{children}</div>
  );
}

export function CoffeeFilm() {
  const frame = useCurrentFrame();
  const time = frame / 30;
  const introLine = between(time, 0.2, 1.4, 0, 174);
  const closing = between(time, 16.4, 17.0, 0, 1);
  const clock = between(time, 7.5, 8.3, 0, 1);
  return (
    <AbsoluteFill style={{ background: "#41251b", overflow: "hidden" }}>
      <CoffeeScene />
      <AbsoluteFill style={{
        background: "linear-gradient(180deg,rgba(25,13,8,.65) 0%,rgba(25,13,8,.25) 24%,transparent 47%,transparent 65%,rgba(25,13,8,.7) 100%)",
      }} />
      <div style={{
        position: "absolute", top: 64, left: 58, right: 58,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        fontFamily: "Coffee Text", fontSize: 20, color: cream,
      }}>
        <span style={{ letterSpacing: 3 }}>НА УГЛУ</span>
        <span style={{ opacity: 0.7 }}>кофейня</span>
      </div>
      <Copy start={0.15} end={3.85}>
        <div style={{ fontSize: 91 }}>Утро.</div>
        <div style={{ fontSize: 91 }}>С хорошего.</div>
        <div style={{ height: 5, width: introLine, background: orange, marginTop: 27 }} />
      </Copy>
      <Copy start={3.95} end={7.5}>
        <div style={{ fontSize: 68 }}>Второй кофе —</div>
        <div style={{ fontSize: 101, color: orange }}>в подарок.</div>
      </Copy>
      <Copy start={7.55} end={11.8}>
        <div style={{ fontFamily: "Coffee Text", fontSize: 31, letterSpacing: 0, textTransform: "none", marginBottom: 8 }}>По будням</div>
        <div style={{ fontSize: 131, fontVariantNumeric: "tabular-nums" }}>до 11:00</div>
        <div style={{ width: `${clock * 100}%`, height: 2, background: cream, opacity: 0.5, marginTop: 19 }} />
      </Copy>
      <Copy start={12.0} end={16.6}>
        <div style={{ fontSize: 81 }}>Хорошее утро</div>
        <div style={{ fontSize: 94, color: orange }}>на двоих.</div>
      </Copy>
      <div style={{
        position: "absolute", inset: 0, background: "#29170f", opacity: closing * 0.28,
      }} />
      <Copy start={16.7} top={157}>
        <div style={{ fontSize: 67 }}>Второй кофе —</div>
        <div style={{ fontSize: 99, color: orange }}>в подарок.</div>
        <div style={{
          fontFamily: "Coffee Text", fontSize: 32, lineHeight: 1.5,
          letterSpacing: 0, textTransform: "none", marginTop: 24,
        }}>По будням до 11:00</div>
      </Copy>
      <div style={{
        position: "absolute", bottom: 176, left: 58, right: 58,
        opacity: closing, color: cream, fontFamily: "Coffee Text",
        fontSize: 30, textAlign: "center",
      }}>Загляните в кофейню на углу.</div>
      <Captions />
      <Sequence from={12} layout="none" premountFor={12}>
        <Audio src={staticFile("narration.mp3")} playbackRate={speed} volume={0.92} />
      </Sequence>
    </AbsoluteFill>
  );
}
