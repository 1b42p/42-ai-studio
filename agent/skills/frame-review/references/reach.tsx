import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

type Point = readonly [x: number, y: number];

function endpoint([x, y]: Point, length: number, degrees: number): Point {
  const radians = degrees * Math.PI / 180;
  return [x + length * Math.cos(radians), y + length * Math.sin(radians)];
}

function arm(shoulder: Point, upperAngle: number, lowerAngle: number) {
  const elbow = endpoint(shoulder, 49, upperAngle);
  return [shoulder, elbow, endpoint(elbow, 44, lowerAngle)] as const;
}

function points(joints: readonly Point[]) {
  return joints.map(([x, y]) => `${x},${y}`).join(" ");
}

export function Reach({ cueMs }: { cueMs: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = frame / fps - cueMs / 1000;
  const lift = interpolate(elapsed, [0, 0.55, 0.95, 1.55], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const left = arm([144, 142], 105 + 150 * lift, 98 + 165 * lift);
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
      <path d="M138 104 Q144 80 162 85 Q181 85 183 105 Q168 101 162 96 Q150 105 138 104"
        fill="#203c31" />
    </svg>
  );
}
