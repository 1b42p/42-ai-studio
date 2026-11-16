"use client";

import BlurText from "@/components/BlurText";
import { heroTitle } from "./content";

const from = { opacity: 1, y: 0, filter: "blur(0px)" };
const to = [
  { opacity: 1, y: -1, filter: "blur(0px)" },
  { opacity: 1, y: 0, filter: "blur(0px)" },
];

/** Enhance an already readable title without a second hidden/blurred entrance. */
export default function HeroTitleMotion() {
  return (
    <BlurText
      text={heroTitle}
      delay={35}
      stepDuration={0.2}
      trigger="load"
      animationFrom={from}
      animationTo={to}
      className="inline!"
    />
  );
}
