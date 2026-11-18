import type { Object3D } from "three";

export function poseSculpturePart(
  object: Object3D,
  pivot: [number, number, number],
  rotation: [number, number, number],
  translation: [number, number, number],
): void;

export function sculpturePhase(seconds: number, duration: number): number;
