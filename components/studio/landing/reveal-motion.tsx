"use client";

import type { RefObject } from "react";

import AnimatedContent from "@/components/AnimatedContent";

export interface RevealMotionProps {
  targetRef: RefObject<HTMLDivElement | null>;
  index: number;
}

/** No wrapper replacement: the server-rendered children keep their DOM/state. */
export default function RevealMotion({ targetRef, index }: RevealMotionProps) {
  return (
    <AnimatedContent
      targetRef={targetRef}
      distance={12}
      duration={0.45}
      delay={index * 0.05}
      animateOpacity={false}
      initialOpacity={1}
    />
  );
}
