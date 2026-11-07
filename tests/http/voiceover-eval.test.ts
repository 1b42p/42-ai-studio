import { Client } from "eve/client";
import type { EveEvalContext, ToolStub } from "eve/evals";
import { expect, inject, test } from "vitest";

import data from "../../evals/fixtures/voiceover/project.json";
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

function readTiming(path: string, timing: unknown) {
  return {
    name: "read_file",
    status: "completed" as const,
    input: { filePath: path },
    output: { path, content: `1: ${JSON.stringify(timing)}` },
  };
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
  const timing = data.scenes[0];
  const receipt = {
    audioPath: path.replace(".words.json", ".wav"),
    timingsPath: path,
    durationMs: timing.durationMs,
    words: timing.words.length,
    mode: "alignment",
  };
  const created = {
    ...call(synth("/workspace/project/voice/scene-01-piper-v2")),
    output: {
      exitCode: 0,
      stdout: JSON.stringify(receipt),
    },
  };
  const read = readTiming(path, timing);
  expect(sceneTimingsAfterSynthesis([read, created])).toEqual([]);
  expect(sceneTimingsAfterSynthesis([created, read])).toEqual([1]);
  expect(
    sceneTimingsAfterSynthesis([
      created,
      readTiming(path, { ...timing, text: `${timing.text}\n` }),
    ]),
  ).toEqual([1]);

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
      stdout: JSON.stringify({
        ...receipt,
        audioPath: receipt.audioPath.replace("-v2", "-v3"),
        timingsPath: newPath,
      }),
    },
  };
  expect(
    sceneTimingsAfterSynthesis([created, read, synthesizedAgain, read]),
  ).toEqual([]);
  expect(
    sceneTimingsAfterSynthesis([
      created,
      read,
      synthesizedAgain,
      readTiming(newPath, timing),
    ]),
  ).toEqual([1]);

  const quotedDirectory = {
    ...created,
    input: {
      command: 'cd "/workspace/project" && ' + synth("voice/scene-01-piper-v2"),
    },
  };
  expect(sceneTimingsAfterSynthesis([quotedDirectory, read])).toEqual([1]);
  const absoluteTextFile = {
    ...created,
    input: {
      command: synth(
        "/workspace/project/voice/scene-01-piper-v2",
        '"/workspace/project/voice/scene-01.txt"',
      ),
    },
  };
  expect(sceneTimingsAfterSynthesis([absoluteTextFile, read])).toEqual([1]);

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

  const foreignText = readTiming(path, { ...timing, text: "Подмена" });
  expect(sceneTimingsAfterSynthesis([created, foreignText])).toEqual([]);
  expect(
    sceneTimingsAfterSynthesis([
      created,
      readTiming(path, { ...timing, text: undefined }),
    ]),
  ).toEqual([]);

  const wrongAudioPath = {
    ...created,
    output: {
      exitCode: 0,
      stdout: JSON.stringify({ ...receipt, audioPath: "/workspace/stub.wav" }),
    },
  };
  expect(sceneTimingsAfterSynthesis([wrongAudioPath, read])).toEqual([]);
});

test("тайминги Piper из цикла соответствуют тексту каждой сцены", () => {
  const receipts = data.scenes.map((timing, index) => {
    const base = `/workspace/project/voice/scene-0${index + 1}-piper-v2`;
    return {
      audioPath: `${base}.wav`,
      timingsPath: `${base}.words.json`,
      durationMs: timing.durationMs,
      words: timing.words.length,
      mode: "alignment",
    };
  });
  const created = {
    ...call(
      'cd "/workspace/project" && for i in 01 02 03; do ' +
        synth('"voice/scene-${i}-piper-v2"') +
        "; done",
    ),
    output: {
      exitCode: 0,
      stdout: receipts.map((item) => JSON.stringify(item)).join("\n"),
    },
  };
  const reads = receipts.map((receipt, index) =>
    readTiming(receipt.timingsPath, data.scenes[index]),
  );
  expect(sceneTimingsAfterSynthesis([created, ...reads])).toEqual([1, 2, 3]);

  const wrongScene = readTiming(receipts[1].timingsPath, {
    ...data.scenes[1],
    text: data.scenes[0].text,
  });
  expect(
    sceneTimingsAfterSynthesis([created, reads[0], wrongScene, reads[2]]),
  ).toEqual([1, 3]);
});

test("speak связывает запрос, квитанцию и прочитанный JSON", () => {
  const base = "/workspace/project/voice/scene-01";
  const timing = {
    ...data.scenes[0],
    voice: "ru-RU-SvetlanaNeural",
    format: "mp3",
  };
  const created = {
    name: "speak",
    status: "completed" as const,
    input: {
      text: `  ${timing.text}\n`,
      voice: timing.voice,
      outputPath: base,
    },
    output: {
      audioPath: `${base}.mp3`,
      timingsPath: `${base}.words.json`,
      voice: timing.voice,
      language: "ru-RU",
      format: "mp3",
      durationMs: timing.durationMs,
      wordCount: timing.words.length,
      text: timing.text,
      media: { audioId: "00000000-0000-4000-8000-000000000001" },
    },
  };
  const read = readTiming(created.output.timingsPath, timing);
  expect(sceneTimingsAfterSynthesis([created, read])).toEqual([1]);
  expect(sceneTimingsAfterSynthesis([read, created])).toEqual([]);

  for (const outputPath of [
    "project/voice/scene-01",
    "./project/voice/scene-01",
    "project/voice/../voice/scene-01",
  ]) {
    expect(
      sceneTimingsAfterSynthesis([
        { ...created, input: { ...created.input, outputPath } },
        read,
      ]),
    ).toEqual([1]);
  }

  for (const output of [
    { ...created.output, text: "Подмена" },
    { ...created.output, voice: "ru-RU-DmitryNeural" },
    { ...created.output, audioPath: "/workspace/stub.mp3" },
    { ...created.output, timingsPath: "/workspace/stub.words.json" },
    {
      ...created.output,
      audioPath: `${base}-v2.mp3`,
      timingsPath: `${base}-v2.words.json`,
    },
  ]) {
    // Даже JSON, совпавший с подменённой квитанцией, не исправляет её запрос.
    const matchingRead = readTiming(output.timingsPath, {
      ...timing,
      text: output.text,
      voice: output.voice,
    });
    expect(
      sceneTimingsAfterSynthesis([{ ...created, output }, matchingRead]),
    ).toEqual([]);
  }

  for (const changed of [
    { text: "Подмена" },
    { text: undefined },
    { voice: "ru-RU-DmitryNeural" },
    { durationMs: 1000 },
  ]) {
    expect(
      sceneTimingsAfterSynthesis([
        created,
        readTiming(created.output.timingsPath, { ...timing, ...changed }),
      ]),
    ).toEqual([]);
  }

  const versioned = {
    ...created,
    input: { ...created.input, outputPath: `${base}-v2` },
    output: {
      ...created.output,
      audioPath: `${base}-v2.mp3`,
      timingsPath: `${base}-v2.words.json`,
    },
  };
  expect(sceneTimingsAfterSynthesis([created, read, versioned, read])).toEqual(
    [],
  );
  expect(
    sceneTimingsAfterSynthesis([
      created,
      read,
      versioned,
      readTiming(versioned.output.timingsPath, timing),
    ]),
  ).toEqual([1]);

  const automatic = {
    ...created,
    input: { text: timing.text },
    output: {
      ...created.output,
      audioPath: "/workspace/voiceover/speech-12345678.mp3",
      timingsPath: "/workspace/voiceover/speech-12345678.words.json",
    },
  };
  const automaticRead = readTiming(automatic.output.timingsPath, timing);
  expect(sceneTimingsAfterSynthesis([automatic, automaticRead])).toEqual([1]);
  expect(
    sceneTimingsAfterSynthesis([
      {
        ...automatic,
        output: { ...automatic.output, audioPath: "/workspace/stub.mp3" },
      },
      automaticRead,
    ]),
  ).toEqual([]);
});
