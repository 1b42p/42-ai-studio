import { readFileSync } from "node:fs";

export const projectSource = readFileSync("evals/fixtures/preview/index.tsx", "utf8");
export const projectProps = (seconds: number) => JSON.stringify({ seconds });
export const initialNotes = (seconds: number) => readFileSync(`evals/fixtures/preview/notes-${seconds}.md`, "utf8");
export const projectPackage = JSON.stringify({
  dependencies: { remotion: "4.0.538", "@remotion/cli": "4.0.538", react: "19.2.3", "react-dom": "19.2.3" },
});

// Recorded bindings of source hash, Main, exact props, frame numbers, paths and
// JPEG hashes. A renderer-only refresh must not silently bless new pixels.
export const frameSnapshotRefs = [
  { seconds: 30, propsSha256: "942f9385150cae1a8b1e5d160d1866d609ff3338b58472529a4dfd43a0bef031",
    fingerprint: "09ccbba8fa0f190b95e990c734267b19eeae6e588f5c82ee43d24df1ddfb78b3" },
  { seconds: 120, propsSha256: "c40f8c2e3b827102332667b74a909bd28a4c7a622af411ef544caf3e0f13ae92",
    fingerprint: "e494ca9735418497d1a327521125260dbcc0ef959cfecef13d775b567d4223de" },
] as const;
