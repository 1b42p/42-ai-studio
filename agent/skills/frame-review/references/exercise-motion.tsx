import { Easing, interpolate, useCurrentFrame } from "remotion";

type Point = readonly [x: number, y: number];
type ActionInterval = { startFrame: number; endFrame: number };

function endpoint([x, y]: Point, length: number, degrees: number): Point {
  const radians = degrees * Math.PI / 180;
  return [x + length * Math.cos(radians), y + length * Math.sin(radians)];
}

function points(joints: readonly Point[]) {
  return joints.map(([x, y]) => `${x},${y}`).join(" ");
}

function useActionProgress({ startFrame, endFrame }: ActionInterval) {
  const frame = useCurrentFrame();
  const progress = (frame - startFrame) / (endFrame - startFrame);
  return interpolate(progress, [0, 0.4, 0.6, 1], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
}

export function Reach(interval: ActionInterval) {
  const lift = useActionProgress(interval);
  const shoulder: Point = [144, 142];
  const elbow = endpoint(shoulder, 49, 105 + 150 * lift);
  const wrist = endpoint(elbow, 44, 98 + 165 * lift);
  const left = [shoulder, elbow, wrist];
  const right = left.map(([x, y]): Point => [320 - x, y]);

  return (
    <svg role="img" aria-label="Подъём рук и возврат" viewBox="0 0 320 320"
      style={{ width: "100%", height: "100%" }}>
      <ellipse cx={160} cy={288} rx={65} ry={8} fill="#dee8de" />
      <path d="M147 193 L139 242 L131 284 H118 M173 193 L181 242 L189 284 H202"
        fill="none" stroke="#203c31" strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" />
      <g stroke="#b86448" strokeWidth={13} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polyline points={points(left)} />
        <polyline points={points(right)} />
      </g>
      <path d="M140 135 Q160 128 180 135 L186 192 Q160 204 134 192 Z" fill="#386d55" />
      <circle cx={160} cy={108} r={23} fill="#d78060" />
    </svg>
  );
}

export function Squat(interval: ActionInterval) {
  const bend = useActionProgress(interval);
  const ankle: Point = [151, 276];
  const knee = endpoint(ankle, 64, -80 + 25 * bend);
  const hip = endpoint(knee, 65, -100 - 57 * bend);
  const shoulder = endpoint(hip, 61, -90 + 28 * bend);
  const head = endpoint(shoulder, 29, -90 + 28 * bend);
  const elbow = endpoint(shoulder, 36, 80 - 72 * bend);
  const wrist = endpoint(elbow, 34, 72 - 87 * bend);

  return (
    <svg role="img" aria-label="Приседание сбоку и возврат" viewBox="0 0 320 320"
      style={{ width: "100%", height: "100%" }}>
      <ellipse cx={160} cy={288} rx={65} ry={8} fill="#dee8de" />
      <g fill="none" strokeWidth={14} strokeLinecap="round" strokeLinejoin="round">
        <polyline points={points([hip, knee, ankle, [178, 281]])} stroke="#203c31" />
        <polyline points={points([hip, shoulder])} stroke="#386d55" />
        <polyline points={points([shoulder, elbow, wrist])} stroke="#b86448" />
      </g>
      <circle cx={head[0]} cy={head[1]} r={20} fill="#d78060" />
    </svg>
  );
}
