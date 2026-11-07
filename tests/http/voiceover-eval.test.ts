import { Client } from "eve/client";
import type { EveEvalContext, ToolStub } from "eve/evals";
import { expect, inject, test } from "vitest";

import { voiceoverSession } from "../../evals/voiceover/fixtures";
import {
  piperScenes,
  sceneTimingsAfterSynthesis,
} from "../../evals/voiceover/observations";
import { loadConfig } from "../../lib/config";

function call(command: string) {
  return {
    name: "bash",
    status: "completed" as const,
    input: { command },
  };
}

function synth(out: string, textFile?: string) {
  const number = /scene-0?([123])/u.exec(out)?.[1];
  const input =
    textFile ?? (number ? `scene-0${number}.txt` : '"scene-${i}.txt"');
  return `python3 /skills/piper_speak.py --voice ru_RU-denis-medium --text-file ${input} --out ${out}`;
}

test.each([false, true])(
  "полный набор подмен voiceover принимается HTTP-сервером eve (fallback=%s)",
  async (fallback) => {
    let captured: readonly ToolStub[] = [];
    const token = loadConfig().eveEvalAuthToken!;
    const context = {
      target: {
        fetch: (path: string) =>
          fetch(`${inject("appUrl")}${path}`, {
            headers: { authorization: `Bearer ${token}` },
          }),
      },
      session: async ({ stubs }: { stubs: readonly ToolStub[] }) => {
        captured = stubs;
        return {};
      },
    } as unknown as EveEvalContext;
    await voiceoverSession(context, fallback);
    expect(captured.length).toBeLessThanOrEqual(100);
    expect(new Set(captured.map(({ id }) => id)).size).toBe(captured.length);

    const client = new Client({
      host: inject("appUrl"),
      auth: { bearer: token },
      redirect: "manual",
    });
    const { session } = await client.sessions.create({ stubs: captured });
    await session.reset();
  },
);

test("оценка Piper не принимает установку или озвучку одной сцены за три", () => {
  expect(piperScenes([call('pip install "piper-tts[alignment]"')])).toEqual([]);
  expect(
    piperScenes([call(synth("/workspace/public/voice/scene-01-piper"))]),
  ).toEqual([1]);

  const touchedScenes = call(
    `${synth("scene-01-piper")}; touch scene-02-piper scene-03-piper`,
  );
  expect(piperScenes([touchedScenes])).toEqual([1]);

  const synthesisOutsideLoop = call(
    `for i in 01 02 03; do echo "$i"; done; ${synth('"scene-$i-piper"')}`,
  );
  expect(piperScenes([synthesisOutsideLoop])).toEqual([]);
});

test("оценка Piper принимает отдельные вызовы и пакетный shell-цикл", () => {
  const separateCalls = [1, 2, 3].map((number) =>
    call(synth(`scene-0${number}-piper`)),
  );
  expect(piperScenes(separateCalls)).toEqual([1, 2, 3]);

  const versionedCalls = [1, 2, 3].map((number) =>
    call(synth(`scene-0${number}-piper-v2`)),
  );
  expect(piperScenes(versionedCalls)).toEqual([1, 2, 3]);

  for (const values of ["01 02 03", "{1..3}", "$(seq 1 3)"]) {
    const loop = call(
      `for i in ${values}; do ${synth('"/workspace/voice/scene-${i}-piper"')}; done`,
    );
    expect(piperScenes([loop])).toEqual([1, 2, 3]);
  }

  const singleSceneLoop = call(
    `for i in 01; do ${synth('"scene-$i-piper"')}; done`,
  );
  expect(piperScenes([singleSceneLoop])).toEqual([1]);
});

test("тайминги должны быть прочитаны после синтеза и по возвращённому пути", () => {
  const path = "/workspace/project/voice/scene-01-piper-v2.words.json";
  const timing = {
    voice: "piper:ru_RU-denis-medium",
    durationMs: 5000,
    words: [{ text: "Слово", startMs: 0, endMs: 5000 }],
  };
  const created = {
    ...call(synth("/workspace/project/voice/scene-01-piper-v2")),
    output: {
      exitCode: 0,
      stdout: JSON.stringify({ timingsPath: path, durationMs: 5000 }),
    },
  };
  const read = {
    name: "read_file",
    status: "completed" as const,
    input: { filePath: path },
    output: { path, content: `1: ${JSON.stringify(timing)}` },
  };
  expect(sceneTimingsAfterSynthesis([read, created])).toEqual([]);
  expect(sceneTimingsAfterSynthesis([created, read])).toEqual([1]);

  const readOldPath = {
    ...read,
    input: { filePath: path.replace("-v2", "") },
  };
  expect(sceneTimingsAfterSynthesis([created, readOldPath])).toEqual([]);
  expect(sceneTimingsAfterSynthesis([created, read, created])).toEqual([]);

  const newPath = path.replace("-v2", "-v3");
  const synthesizedAgain = {
    ...created,
    input: { command: created.input.command.replace("-v2", "-v3") },
    output: {
      exitCode: 0,
      stdout: JSON.stringify({ timingsPath: newPath, durationMs: 5000 }),
    },
  };
  expect(
    sceneTimingsAfterSynthesis([created, read, synthesizedAgain, read]),
  ).toEqual([]);

  const quotedDirectory = {
    ...created,
    input: {
      command: 'cd "/workspace/project" && ' + synth("voice/scene-01-piper-v2"),
    },
  };
  expect(sceneTimingsAfterSynthesis([quotedDirectory, read])).toEqual([1]);

  const wrongText = {
    ...created,
    input: {
      command: synth(
        "/workspace/project/voice/scene-01-piper-v2",
        "scene-02.txt",
      ),
    },
  };
  expect(sceneTimingsAfterSynthesis([wrongText, read])).toEqual([]);

  const wrongVoice = {
    ...created,
    input: {
      command: created.input.command.replace(
        "ru_RU-denis-medium",
        "en_US-ryan-medium",
      ),
    },
  };
  expect(sceneTimingsAfterSynthesis([wrongVoice, read])).toEqual([]);

  const wrongDuration = {
    ...read,
    output: { path, content: JSON.stringify({ ...timing, durationMs: 4500 }) },
  };
  expect(sceneTimingsAfterSynthesis([created, wrongDuration])).toEqual([]);
});
