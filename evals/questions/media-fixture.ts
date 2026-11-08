import data from "../fixtures/questions/frames.json";

export const questionFrames = data.frames;

export function reviewFrames(seconds: number) {
  const total = seconds * 30;
  return [0, Math.round(total / 12), total / 3 - 1, total / 3, total / 2, total * 2 / 3, Math.round(total * 5 / 6), total - 1];
}

export function frameOutput(index: number, corrected: boolean) {
  const frame = questionFrames.find((item) => item.index === index && item.corrected === corrected)!;
  return {
    path: frame.path, content: `Image ${frame.width}x${frame.height}`, totalLines: 1, truncated: false,
    file: { mediaType: "image/jpeg", width: frame.width, height: frame.height, size: frame.size },
  };
}
