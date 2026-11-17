"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { cn } from "@/lib/utils";

const ModelViewer = dynamic(() => import("@/components/ModelViewer"), {
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
        src="/landing/studio-orbit.webp"
        alt=""
        width={1040}
        height={960}
        fetchPriority="high"
        decoding="async"
        className={cn(
          "absolute inset-0 size-full object-contain transition-opacity duration-500 motion-reduce:transition-none",
          ready && showModel && "opacity-0",
        )}
      />
      {showModel && (
        <SceneBoundary onFailure={onFailure}>
          <ModelViewer
            url="/landing/studio-orbit.glb"
            width="100%"
            height="100%"
            className="absolute! inset-0"
            environment="studio"
            environmentIntensity={dark ? 1.3 : 1.15}
            exposure={dark ? 1.15 : 1.05}
            fit={1.12}
            startAngle={-8}
            tilt={5}
            intro="none"
            autoRotate={!reducedMotion}
            autoRotateSpeed={0.025}
            autoRotateDelay={0}
            float={reducedMotion ? 0 : 0.18}
            hoverTilt={reducedMotion ? 0 : 0.07}
            dragRotate
            turntable
            zoom={false}
            shadow
            shadowOpacity={dark ? 0.22 : 0.13}
            active={visible}
            onModelLoaded={handleReady}
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
      ratio={13 / 12}
      className={cn("relative isolate", className)}
      role="img"
      aria-label="Объёмная оранжевая кнопка воспроизведения в орбите киноленты"
    >
      <SceneVisual
        key={showModel ? "model" : "poster"}
        showModel={showModel}
        dark={dark}
        reducedMotion={reducedMotion}
        visible={visible}
        onFailure={() => setFailed(true)}
      />
    </AspectRatio>
  );
}
