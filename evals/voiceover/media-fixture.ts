import data from "../fixtures/voiceover/frames.json";

export const voiceoverFrames = data.frames.map((frame) => ({
  ...frame,
  path: `/workspace/.eval/voiceover/frame-${frame.number}.jpeg`,
}));

export const voiceoverFrameOutputs = voiceoverFrames.map((frame) => ({
  path: frame.path,
  content: `Image ${frame.width}x${frame.height}`,
  totalLines: 1,
  truncated: false,
  file: { mediaType: "image/jpeg", width: frame.width, height: frame.height, size: frame.size },
}));
