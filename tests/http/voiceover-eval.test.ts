import { Client } from "eve/client";
import type { EveEvalContext, ToolStub } from "eve/evals";
import { expect, inject, test } from "vitest";
import { voiceoverSession } from "../../evals/voiceover/fixtures";
import { piperScenes } from "../../evals/voiceover/observations";
import { loadConfig } from "../../lib/config";

const call = (command: string) => ({ name: "bash", status: "completed" as const, input: { command } });
const synth = (out: string) => `python3 /skills/piper_speak.py --voice ru_RU-denis-medium --text-file scene.txt --out ${out}`;

test.each([false, true])("полный набор подмен voiceover принимается HTTP-сервером eve (fallback=%s)", async (fallback) => {
  let captured: readonly ToolStub[] = [];
  const token = loadConfig().eveEvalAuthToken!;
  const context = {
    target: { fetch: (path: string) => fetch(`${inject("appUrl")}${path}`, { headers: { authorization: `Bearer ${token}` } }) },
    session: async ({ stubs }: { stubs: readonly ToolStub[] }) => { captured = stubs; return {}; },
  } as unknown as EveEvalContext;
  await voiceoverSession(context, fallback);
  expect(captured.length).toBeLessThanOrEqual(100);
  expect(new Set(captured.map(({ id }) => id)).size).toBe(captured.length);
  const client = new Client({ host: inject("appUrl"), auth: { bearer: token }, redirect: "manual" });
  const { session } = await client.sessions.create({ stubs: captured });
  await session.reset();
});

test("оценка Piper не принимает установку или озвучку одной сцены за три", () => {
  expect(piperScenes([call('pip install "piper-tts[alignment]"')])).toEqual([]);
  expect(piperScenes([call(synth("/workspace/public/voice/scene-01-piper"))])).toEqual([1]);
  expect(piperScenes([call(`${synth("scene-01-piper")}; touch scene-02-piper scene-03-piper`)])).toEqual([1]);
  expect(piperScenes([call(`for i in 01 02 03; do echo "$i"; done; ${synth('"scene-$i-piper"')}`)])).toEqual([]);
});

test("оценка Piper принимает отдельные вызовы и пакетный shell-цикл", () => {
  expect(piperScenes([1, 2, 3].map((number) => call(synth(`scene-0${number}-piper`))))).toEqual([1, 2, 3]);
  for (const values of ["01 02 03", "{1..3}", "$(seq 1 3)"]) {
    expect(piperScenes([call(`for i in ${values}; do ${synth('"/workspace/voice/scene-${i}-piper"')}; done`)])).toEqual([1, 2, 3]);
  }
  expect(piperScenes([call(`for i in 01; do ${synth('"scene-$i-piper"')}; done`)])).toEqual([1]);
});
