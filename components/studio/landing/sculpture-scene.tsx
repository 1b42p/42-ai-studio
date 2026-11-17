"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { cn } from "@/lib/utils";
import { sculptureCompositions, type SculptureComposition } from "./sculpture-config";

const KineticCanvas = dynamic(() => import("./kinetic-canvas"), {
  ssr: false,
  loading: () => null,
});

class SceneBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailure();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SceneVisual({
  composition,
  showModel,
  dark,
  reducedMotion,
  visible,
  onFailure,
}: {
  composition: SculptureComposition;
  showModel: boolean;
  dark: boolean;
  reducedMotion: boolean;
  visible: boolean;
  onFailure: () => void;
}) {
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);

  return (
    <>
      {(["light", "dark"] as const).map((theme) => (
        <img
          key={theme}
          data-sculpture-theme={theme}
          src={`/landing/${sculptureCompositions[composition].asset}-${theme}.webp`}
          alt=""
          width={sculptureCompositions[composition].width}
          height={sculptureCompositions[composition].height}
          loading="lazy"
          fetchPriority={composition === "hero" ? "high" : "auto"}
          decoding="async"
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-500 motion-reduce:transition-none",
            theme === "light" ? "dark:hidden" : "hidden dark:block",
            composition === "hero" && "object-[70%_center] md:object-center",
            ready && showModel && "opacity-0",
          )}
        />
      ))}
      {showModel && (
        <SceneBoundary onFailure={onFailure}>
          <KineticCanvas
            composition={composition}
            theme={dark ? "dark" : "light"}
            reducedMotion={reducedMotion}
            active={visible}
            onReady={handleReady}
            onFailure={onFailure}
          />
        </SceneBoundary>
      )}
    </>
  );
}

/** Shared lifecycle; each composition keeps its own geometry and framing. */
export function SculptureScene({
  composition,
  className,
}: {
  composition: SculptureComposition;
  className?: string;
}) {
  const definition = sculptureCompositions[composition];
  const root = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [eligible, setEligible] = useState(false);
  const [visible, setVisible] = useState(false);
  const [seen, setSeen] = useState(false);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const handleFailure = useCallback(() => setFailed(true), []);
  const canInitialize = !definition.defer || seen;

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let webglAvailable: boolean | undefined;
    const update = () => {
      if (desktop.matches && canInitialize && webglAvailable === undefined) {
        const canvas = document.createElement("canvas");
        try {
          const context = canvas.getContext("webgl2");
          webglAvailable = context !== null;
          context?.getExtension("WEBGL_lose_context")?.loseContext();
        } catch {
          webglAvailable = false;
        }
      }
      setEligible(desktop.matches && canInitialize && webglAvailable === true);
      setReducedMotion(motion.matches);
    };
    update();
    desktop.addEventListener("change", update);
    motion.addEventListener("change", update);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setPainted(true));
    });
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) setSeen(true);
      },
      { threshold: 0.01 },
    );
    const container = root.current;
    const handleContextLoss = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    if (container) {
      observer.observe(container);
      container.addEventListener("webglcontextlost", handleContextLoss, true);
    }
    return () => {
      desktop.removeEventListener("change", update);
      motion.removeEventListener("change", update);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      observer.disconnect();
      container?.removeEventListener("webglcontextlost", handleContextLoss, true);
    };
  }, [canInitialize]);

  const dark = resolvedTheme === "dark";
  const showModel = eligible && painted && canInitialize && !failed;

  return (
    <AspectRatio
      ref={root}
      ratio={definition.width / definition.height}
      className={cn("relative isolate w-full overflow-hidden", className)}
      role="img"
      aria-label={definition.label}
    >
      <SceneVisual
        key={`${composition}-${showModel ? "model" : "poster"}-${dark ? "dark" : "light"}`}
        composition={composition}
        showModel={showModel}
        dark={dark}
        reducedMotion={reducedMotion}
        visible={visible}
        onFailure={handleFailure}
      />
    </AspectRatio>
  );
}
