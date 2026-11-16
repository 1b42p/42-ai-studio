"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import Features4 from "@/components/ui/feature-4";
import { heroTitle, landingFeatures } from "./content";
import { useDeferredMotion } from "./deferred-motion";

const loadTitleMotion = () => import("./hero-title-motion");
const loadRevealMotion = () => import("./reveal-motion");

const Aurora = dynamic(() => import("@/components/Aurora"), { ssr: false });
const MagicBento = dynamic(() => import("@/components/MagicBento"), {
  ssr: false,
  loading: () => <Features4 items={landingFeatures} />,
});

function subscribeMotion(callback: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
}

export function HeroTitle() {
  const reduced = useReducedMotion();
  const TitleMotion = useDeferredMotion(loadTitleMotion, !reduced);
  return (
    <h1 className="font-heading max-w-5xl text-4xl leading-[1.12] font-semibold tracking-tight text-balance md:text-6xl">
      {TitleMotion ? <TitleMotion /> : heroTitle}
    </h1>
  );
}

export function HeroBackground() {
  const { resolvedTheme } = useTheme();
  const reduced = useReducedMotion();
  const [palette, setPalette] = useState<string[] | null>(null);
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    // Avoid WebGL startup and its per-frame cost on a phone altogether.
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    // next-themes applies the root class in its effect. Read on the next frame,
    // after the provider has applied the new theme, not the previous palette.
    const frame = requestAnimationFrame(() => {
      const tokens = getComputedStyle(document.documentElement);
      setPalette(["--primary", "--chart-2", "--primary"].map((name) => tokens.getPropertyValue(name).trim()));
    });
    return () => cancelAnimationFrame(frame);
  }, [resolvedTheme, desktop]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden bg-linear-to-b from-primary/5 to-background">
      {desktop && palette && (
        <Aurora
          colorStops={palette}
          lightMode={resolvedTheme !== "dark"}
          paused={reduced}
          intro={false}
          mouseInteraction={false}
          speed={0.3}
          opacity={0.2}
          dpr={1}
        />
      )}
    </div>
  );
}

export function Reveal({ children, index = 0 }: { children: ReactNode; index?: number }) {
  const reduced = useReducedMotion();
  const targetRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (reduced || !target) return;
    let firstObservation = true;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((entry) => entry.target === target);
      if (!entry) return;
      const initiallyVisible = firstObservation && entry.isIntersecting;
      firstObservation = false;
      if (initiallyVisible) {
        observer.disconnect();
        return;
      }
      if (!entry.isIntersecting) return;
      setNearViewport(true);
      observer.disconnect();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [reduced]);

  const RevealMotion = useDeferredMotion(loadRevealMotion, !reduced && nearViewport);
  return (
    <div ref={targetRef} className="h-full">
      {children}
      {RevealMotion && <RevealMotion targetRef={targetRef} index={index} />}
    </div>
  );
}

export function LandingFeatures() {
  const { resolvedTheme } = useTheme();
  const reduced = useReducedMotion();
  const targetRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const target = targetRef.current;
    if (reduced || mounted || !target) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setMounted(true);
      observer.disconnect();
    }, { rootMargin: "160px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [mounted, reduced]);

  // This same complete list is in the static HTML and the first client render.
  return (
    <div ref={targetRef} className="min-w-0 w-full">
      {!mounted || reduced ? <Features4 items={landingFeatures} /> : (
        <MagicBento
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          textAutoHide={false}
          disableAnimations={reduced}
          items={landingFeatures.map(({ title, description, icon: Icon }) => ({
            id: title,
            title,
            description,
            icon: <Icon />,
          }))}
        />
      )}
    </div>
  );
}
