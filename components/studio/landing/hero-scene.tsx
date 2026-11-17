"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { cn } from "@/lib/utils";

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
  showModel,
  dark,
  reducedMotion,
  visible,
  onFailure,
}: {
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
      <img
        src={`/landing/kinetic-${dark ? "dark" : "light"}.webp`}
        alt=""
        width={1920}
        height={1080}
        fetchPriority="high"
        decoding="async"
        className={cn(
          "absolute inset-0 size-full object-cover object-[70%_center] transition-opacity duration-500 motion-reduce:transition-none md:object-center",
          ready && showModel && "opacity-0",
        )}
      />
      {showModel && (
        <SceneBoundary onFailure={onFailure}>
          <KineticCanvas
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

/** Original local film sculpture. Phones render the exact scene's baked poster. */
export function HeroScene({ className }: { className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [eligible, setEligible] = useState(false);
  const [visible, setVisible] = useState(false);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const handleFailure = useCallback(() => setFailed(true), []);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let webglAvailable: boolean | undefined;
    const update = () => {
      if (desktop.matches && webglAvailable === undefined) {
        const canvas = document.createElement("canvas");
        try {
          const context = canvas.getContext("webgl2");
          webglAvailable = context !== null;
          context?.getExtension("WEBGL_lose_context")?.loseContext();
        } catch {
          webglAvailable = false;
        }
      }
      setEligible(desktop.matches && webglAvailable === true);
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
      ([entry]) => setVisible(entry.isIntersecting),
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
  }, []);

  const dark = resolvedTheme === "dark";
  const showModel = eligible && painted && !failed;

  return (
    <AspectRatio
      ref={root}
      ratio={16 / 9}
      className={cn("relative isolate size-full overflow-hidden", className)}
      role="img"
      aria-label="Кинетическая скульптура из оранжевых кинолент"
    >
      <SceneVisual
        key={`${showModel ? "model" : "poster"}-${dark ? "dark" : "light"}`}
        showModel={showModel}
        dark={dark}
        reducedMotion={reducedMotion}
        visible={visible}
        onFailure={handleFailure}
      />
    </AspectRatio>
  );
}
