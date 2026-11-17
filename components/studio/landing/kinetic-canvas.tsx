"use client";

import { useEffect, useRef } from "react";
import { WebGLRenderer } from "three";
import { animateKineticSculpture, assembleKineticStage, kineticCamera } from "@/lib/landing/kinetic-sculpture.mjs";
import { disposeKineticModel, kineticYield, loadKineticAssets } from "./kinetic-assets";

interface KineticCanvasProps {
  theme: "light" | "dark";
  active: boolean;
  reducedMotion: boolean;
  onReady: () => void;
  onFailure: () => void;
}

export default function KineticCanvas({
  theme,
  active,
  reducedMotion,
  onReady,
  onFailure,
}: KineticCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const settings = useRef({ active, reducedMotion });
  settings.current = { active, reducedMotion };
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const controller = new AbortController();
    const { signal } = controller;
    let renderer: WebGLRenderer | undefined;
    let assets: Awaited<ReturnType<typeof loadKineticAssets>> | undefined;
    let stage: ReturnType<typeof assembleKineticStage> | undefined;
    let initialized = false;
    let stopped = false;
    let frame = 0;
    let previous = 0;
    let elapsed = 0;
    let announced = false;
    const dispose = () => {
      if (assets) {
        // assembleKineticStage reparents Light-Cut out of the loader's wrapper.
        disposeKineticModel(assets.sculpture);
        assets.environment.dispose();
        assets = undefined;
      }
      renderer?.dispose();
      renderer = undefined;
      stage = undefined;
    };
    const stop = () => {
      stopped = true;
      controller.abort();
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
      dispose();
    };
    const fail = () => {
      if (stopped) return;
      stop();
      onFailure();
    };
    const render = () => {
      if (stopped || !renderer || !stage) return;
      renderer.render(stage.scene, stage.camera);
      if (!stopped && !announced) {
        announced = true;
        onReady();
      }
    };
    const tick = (now: number) => {
      frame = 0;
      if (stopped || !initialized || !stage || !settings.current.active || document.hidden) {
        previous = 0;
        return;
      }
      if (previous && !settings.current.reducedMotion) {
        elapsed += Math.min((now - previous) / 1000, 0.1);
      }
      previous = now;
      try {
        animateKineticSculpture(stage.sculpture, elapsed);
        render();
      } catch {
        fail();
        return;
      }
      if (!stopped && !settings.current.reducedMotion) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (stopped || !initialized || !settings.current.active || document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
        previous = 0;
        return;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };
    wake.current = start;
    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (stopped || !initialized || !renderer || !stage || !width || !height) return;
      renderer.setSize(width, height, false);
      const aspect = width / height;
      stage.camera.aspect = aspect;
      // Match an object-cover crop of the native 16:9 poster.
      stage.camera.fov = 2 * Math.atan(
        Math.tan(kineticCamera.fov * Math.PI / 360) * Math.min(1, (16 / 9) / aspect),
      ) * 180 / Math.PI;
      stage.camera.updateProjectionMatrix();
      start();
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      fail();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    element.addEventListener("webglcontextlost", contextLost);
    document.addEventListener("visibilitychange", start);
    const initialize = async () => {
      try {
        await kineticYield(signal);
        renderer = new WebGLRenderer({
          canvas: element,
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: "low-power",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        await kineticYield(signal);
        const loaded = await loadKineticAssets(theme, signal);
        if (stopped) {
          disposeKineticModel(loaded.model);
          loaded.environment.dispose();
          return;
        }
        assets = loaded;
        stage = assembleKineticStage(renderer, theme, assets.sculpture, assets.environment);
        await kineticYield(signal);
        renderer.initTexture(assets.environment);
        await kineticYield(signal);
        // r180's async compiler cannot cancel its polling after context loss.
        renderer.compile(stage.scene, stage.camera);
        signal.throwIfAborted();
        await kineticYield(signal);
        initialized = true;
        resize();
      } catch {
        if (!stopped) fail();
      }
    };
    void initialize();

    return () => {
      wake.current = null;
      stop();
      observer.disconnect();
      element.removeEventListener("webglcontextlost", contextLost);
      document.removeEventListener("visibilitychange", start);
    };
  }, [theme, onReady, onFailure]);

  useEffect(() => {
    wake.current?.();
  }, [active, reducedMotion]);

  return <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 size-full" />;
}
