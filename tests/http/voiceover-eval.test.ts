import { expect, test } from "vitest";
import { piperScenes } from "../../evals/voiceover/observations";

const call = (command: string) => ({ name: "bash", status: "completed" as const, input: { command } });
const synth = (out: string) => `python3 /skills/piper_speak.py --voice ru_RU-denis-medium --text-file scene.txt --out ${out}`;

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
