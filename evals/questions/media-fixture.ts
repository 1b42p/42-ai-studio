import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { JustBashFilesystem } from "eve/sandbox/just-bash";
import data from "../fixtures/questions/frames.json";

export type PropsVersion = 1 | 2;
export type FramePass = 1 | 2;
export const questionDurations = [30, 120] as const;
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const questionProjectPath = (seconds: number) => `/workspace/calm-morning-${seconds}`;
export const questionProps = (version: PropsVersion) => JSON.stringify({
  title: version === 1 ? "Кофе начинается с зерна" : "Утро начинается с кофе",
});

export function reviewFrames(seconds: number) {
  if (!questionDurations.some(duration => duration === seconds)) throw new Error(`Не записана длительность ${seconds}.`);
  const total = seconds * 30;
  return [0, Math.round(total / 12), total / 3 - 1, total / 3, total / 2, total * 2 / 3, Math.round(total * 5 / 6), total - 1];
}

export const frameName = (seconds: number, frame: number) =>
  `element-${String(frame).padStart(String(seconds * 30 - 1).length, "0")}.jpeg`;
export const frameDirectory = (version: PropsVersion, pass: FramePass) => `out/props-v${version}/frames-${pass}`;
export const framePasses = (version: PropsVersion): FramePass[] => version === 1 ? [1, 2] : [2];

/** The recorder and the agent's immutable source snapshot use the same bytes. */
export function questionSources(seconds: number) {
  reviewFrames(seconds);
  return {
    "src/index.ts": "import {registerRoot} from 'remotion';import {Root} from './Root';registerRoot(Root);",
    "src/Root.tsx": `import React from "react";
import {Composition, useCurrentFrame, useVideoConfig} from "remotion";
import {Coffee} from "./Coffee";
type Props={title:string};
const Main=({title}:Props)=> {const frame=useCurrentFrame();const {durationInFrames}=useVideoConfig();return <Coffee scene={Math.min(2,Math.floor(frame/(durationInFrames/3)))} frame={frame} title={title}/>;};
export const Root=()=> <Composition id="Main" component={Main} defaultProps={{title:"Кофе начинается с зерна"}} durationInFrames={${seconds * 30}} fps={30} width={1920} height={1080}/>;`,
    "src/Coffee.tsx": readFileSync("evals/fixtures/questions/Coffee.tsx", "utf8"),
  };
}

export interface QuestionFrame {
  seconds: number;
  version: PropsVersion;
  pass: FramePass;
  frame: number;
  scene: number;
  composition: string;
  sourceSha256: string;
  propsSha256: string;
  path: string;
  width: number;
  height: number;
  size: number;
  sha256: string;
  base64: string;
  extrema: number[][];
}

export interface QuestionSnapshot {
  seconds: number;
  version: PropsVersion;
  composition: string;
  sourceSha256: string;
  propsSha256: string;
  fingerprint: string;
}

export interface QuestionRecording {
  schemaVersion: number;
  renderer: { kind: string; react: string; reactDom: string; playwright: string; browser: string; jpegQuality: number };
  snapshots: QuestionSnapshot[];
  frames: QuestionFrame[];
}

// This shape remains compatible with the existing JustBash byte seeder.
// Validation is explicit so the recorder can replace an obsolete recording.
const recording = data as unknown as QuestionRecording;
export const questionFrames = recording.frames;

export function snapshotBinding(seconds: number, version: PropsVersion, frames: readonly QuestionFrame[]) {
  return {
    seconds, version, composition: "Main", fps: 30, width: 1920, height: 1080,
    sourceSha256: sha256(JSON.stringify(questionSources(seconds))),
    propsSha256: sha256(questionProps(version)),
    frames: frames.map(({ frame, pass, path, sha256, size, width, height, extrema }) =>
      ({ frame, pass, path, sha256, size, width, height, extrema })),
  };
}

export function questionSnapshot(seconds: number, version: PropsVersion) {
  const frames = questionFrames.filter(frame => frame.seconds === seconds && frame.version === version);
  const snapshot = recording.snapshots?.find(item => item.seconds === seconds && item.version === version);
  const expected = framePasses(version).flatMap(pass => reviewFrames(seconds).map(frame => ({
    pass, frame, path: `${questionProjectPath(seconds)}/${frameDirectory(version, pass)}/${frameName(seconds, frame)}`,
  })));
  const binding = snapshotBinding(seconds, version, frames);
  if (recording.schemaVersion !== 2 || recording.renderer.kind !== "react-dom/server+playwright" ||
    recording.renderer.jpegQuality !== 90 || !snapshot || snapshot.composition !== "Main" ||
    snapshot.sourceSha256 !== binding.sourceSha256 || snapshot.propsSha256 !== binding.propsSha256 ||
    snapshot.fingerprint !== sha256(JSON.stringify(binding)) || frames.length !== expected.length) {
    throw new Error(`Исходник, props и JPEG ${seconds} секунд / v${version} не соответствуют записи.`);
  }
  for (const [index, frame] of frames.entries()) {
    const bytes = Buffer.from(frame.base64, "base64");
    const identity = expected[index];
    if (frame.path !== identity.path || frame.frame !== identity.frame || frame.pass !== identity.pass ||
      frame.scene !== Math.min(2, Math.floor(frame.frame / (seconds * 10))) || frame.composition !== "Main" ||
      frame.sourceSha256 !== binding.sourceSha256 || frame.propsSha256 !== binding.propsSha256 ||
      frame.width !== 1920 || frame.height !== 1080 || bytes.length !== frame.size ||
      bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9 ||
      sha256(bytes) !== frame.sha256 || frame.extrema.length !== 3 ||
      frame.extrema.some(pair => pair.length !== 2 || pair.some(value => !Number.isInteger(value) || value < 0 || value > 255) || pair[0] > pair[1])) {
      throw new Error(`Повреждены происхождение или байты кадра ${frame.path}.`);
    }
  }
  return snapshot;
}

export function questionFramesFor(seconds: number, version: PropsVersion, pass: FramePass) {
  questionSnapshot(seconds, version);
  if (!framePasses(version).includes(pass)) throw new Error(`Не записан проход ${pass} для props-v${version}.json.`);
  return questionFrames.filter(frame => frame.seconds === seconds && frame.version === version && frame.pass === pass);
}

export function frameOutput(frame: QuestionFrame) {
  return {
    path: frame.path, content: `Image ${frame.width}x${frame.height}`, totalLines: 1, truncated: false,
    file: { mediaType: "image/jpeg", width: frame.width, height: frame.height, size: frame.size },
  };
}

/** Replace stale cached bytes too: exists(path) alone cannot prove provenance. */
export async function seedQuestionFrames(filesystem: Pick<JustBashFilesystem, "mkdir" | "writeFile" | "readFileBuffer">) {
  for (const seconds of questionDurations) for (const version of [1, 2] as const) questionSnapshot(seconds, version);
  for (const frame of questionFrames) {
    await filesystem.mkdir(posix.dirname(frame.path), { recursive: true });
    await filesystem.writeFile(frame.path, Buffer.from(frame.base64, "base64"));
    if (sha256(await filesystem.readFileBuffer(frame.path)) !== frame.sha256) {
      throw new Error(`Не сохранены записанные пиксели ${frame.path}.`);
    }
  }
}
