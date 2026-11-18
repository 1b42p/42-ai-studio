import { Euler, Quaternion, Vector3 } from "three";

// Runtime-only snapshots work equally with authored groups and glTF nodes.
// Nothing is written into the exported asset or accumulated between frames.
const restTransforms = new WeakMap();
const angles = new Euler();
const turn = new Quaternion();
const pivotPoint = new Vector3();
const displacement = new Vector3();

export function poseSculpturePart(object, pivot, rotation, translation) {
  let rest = restTransforms.get(object);
  if (!rest) {
    rest = {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
    };
    restTransforms.set(object, rest);
  }
  object.position.copy(rest.position);
  object.quaternion.copy(rest.quaternion);
  if (rotation.every((value) => value === 0) && translation.every((value) => value === 0)) return;

  turn.setFromEuler(angles.set(...rotation));
  // Rotate around an authored local point without reparenting the glTF graph.
  pivotPoint.set(...pivot);
  displacement.copy(pivotPoint).applyQuaternion(turn);
  displacement.subVectors(pivotPoint, displacement);
  displacement.add(pivotPoint.set(...translation)).applyQuaternion(rest.quaternion);
  object.position.add(displacement);
  object.quaternion.multiply(turn);
}

export function sculpturePhase(seconds, duration) {
  // Explicit wrap makes every cycle's rest frame exact, even after long visits.
  return ((seconds % duration) / duration) * Math.PI * 2;
}
