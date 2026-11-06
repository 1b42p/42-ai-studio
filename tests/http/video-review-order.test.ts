import { describe, expect, test } from "vitest";

import { framesBeforeFullRender } from "../../evals/video/observations";
import { event } from "../render/fixtures/events";

const request = (actions: { callId: string; kind: "tool-call"; toolName: string; input: Record<string, string> }[]) =>
  event("actions.requested", { actions, sequence: 0, stepIndex: 0, turnId: "turn_0" });
const call = (callId: string, toolName: string, input: Record<string, string>) =>
  ({ callId, kind: "tool-call" as const, toolName, input });
const result = (callId: string, toolName: string, output: object) => event("action.result", {
  result: { callId, kind: "tool-result", toolName, output, isError: false },
  status: "completed", sequence: 0, stepIndex: 0, turnId: "turn_0",
});
function frames(prefix: string) {
  const calls = Array.from({ length: 4 }, (_, index) =>
    call(`${prefix}-${index}`, "read_file", { filePath: `/workspace/project/out/${index}.jpeg` }));
  const completed = calls.map(({ callId, input }) => result(callId, "read_file", {
    path: input.filePath, file: { mediaType: "image/jpeg", width: 1080, height: 1920, size: 1024 },
  }));
  return { calls, requested: request(calls), completed, all: [request(calls), ...completed] };
}
function edit(path = "/workspace/project/src/Root.tsx") {
  const action = call(`edit-${path}`, "edit_file", { filePath: path, oldString: "old", newString: "new" });
  return { action, all: [request([action]), result(action.callId, "edit_file", {
    path, oldContent: "old", newContent: "new", created: false, replacements: 1,
  })] };
}
const render = request([call("render", "bash", { command: "npx remotion render src/index.ts Main out/final.mp4" })]);

describe("актуальность просмотренных кадров", () => {
  test("правка композиции отменяет прежние четыре просмотра", () => {
    expect(framesBeforeFullRender([...frames("before").all, ...edit().all, render])).toBe(false);
  });

  test("после правки нужны четыре новых завершённых просмотра, даже с теми же путями", () => {
    const after = frames("after");
    const prefix = [...frames("before").all, ...edit().all, after.requested];
    expect(framesBeforeFullRender([...prefix, ...after.completed.slice(0, 3), render])).toBe(false);
    expect(framesBeforeFullRender([...prefix, ...after.completed, render])).toBe(true);
  });

  test("обновление NOTES.md не меняет композицию", () => {
    expect(framesBeforeFullRender([...frames("before").all, ...edit("project/NOTES.md").all, render])).toBe(true);
  });

  test("полный рендер одновременно с правкой не считается проверенным", () => {
    expect(framesBeforeFullRender([...frames("before").all,
      request([edit().action, call("parallel-render", "bash", { command: "npx remotion render src/index.ts Main out/final.mp4" })])])).toBe(false);
  });

  test("завершившиеся после правки старые чтения не становятся новыми просмотрами", () => {
    const before = frames("in-flight");
    expect(framesBeforeFullRender([before.requested, ...edit().all, ...before.completed, render])).toBe(false);
  });

  test("чтения, начатые одновременно с правкой, не заменяют проверку после неё", () => {
    const before = frames("parallel");
    const editing = edit();
    expect(framesBeforeFullRender([request([editing.action, ...before.calls]),
      editing.all[1], ...before.completed, render])).toBe(false);
  });

  test("проверяется каждый полный рендер, а не только первый", () => {
    expect(framesBeforeFullRender([...frames("before").all, render, ...edit().all, render])).toBe(false);
  });
});
