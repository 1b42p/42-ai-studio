import type { Group, Object3D, PerspectiveCamera, Scene, Texture, WebGLRenderer, WebGLRenderTarget } from "three";

export const kineticCamera: {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
};

export function createKineticSculpture(theme: "light" | "dark"): Group;

export function createKineticEnvironment(renderer: WebGLRenderer, theme: "light" | "dark"): WebGLRenderTarget;

export function assembleKineticStage(
  renderer: WebGLRenderer,
  theme: "light" | "dark",
  sculpture: Object3D,
  environment: Texture,
): {
  scene: Scene;
  camera: PerspectiveCamera;
  sculpture: Object3D;
};

export function createKineticStage(renderer: WebGLRenderer, theme: "light" | "dark"): {
  scene: Scene;
  camera: PerspectiveCamera;
  sculpture: Object3D;
  environmentTarget: WebGLRenderTarget;
};

export function animateKineticSculpture(sculpture: Object3D, seconds: number): void;
