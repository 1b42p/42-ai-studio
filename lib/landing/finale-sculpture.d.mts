import type { Group, Object3D, PerspectiveCamera, Scene, Texture, WebGLRenderer } from "three";

export const finaleCamera: {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
  aspect: number;
};

export function createFinaleSculpture(theme?: "light" | "dark"): Group;
export function assembleFinaleStage(
  renderer: WebGLRenderer,
  theme: "light" | "dark",
  sculpture: Object3D,
  environment: Texture,
): { scene: Scene; camera: PerspectiveCamera; sculpture: Object3D };
export function animateFinaleSculpture(sculpture: Object3D, seconds: number): void;
