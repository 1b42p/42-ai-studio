import manifest from "./examples.json";

export interface ExampleVideo {
  id: string;
  title: string;
  request: string;
  format: "16:9" | "9:16";
  durationSec: number;
  features: readonly string[];
  video: string;
  poster: string;
  width: number;
  height: number;
  bytes: number;
}

export const examples: readonly ExampleVideo[] = manifest as ExampleVideo[];
