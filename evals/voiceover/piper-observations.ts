import { posix } from "node:path";
import type { EveEvalToolCall } from "eve/evals";
import { resolveSpeechOutputPath } from "../../lib/speech/path";
import data from "../fixtures/voiceover/project.json";

export type ObservedCall = Pick<EveEvalToolCall, "name" | "status" | "input">;
export type ObservedCallResult = ObservedCall & Pick<EveEvalToolCall, "output">;

interface PiperInvocation {
  out: string;
  textFile: string;
  voice: string;
}

interface SynthesisTiming {
  scene: number;
  durationMs: number;
  voice: string;
  text: string;
}

interface SynthesisReceipt extends SynthesisTiming {
  timingsPath: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellArgument(command: string, flag: string): string | undefined {
  return new RegExp(`--${flag}(?:=|\\s+)("[^"]*"|'[^']*'|[^\\s;]+)`, "u")
    .exec(command)?.[1]
    ?.replace(/^["']|["']$/gu, "");
}

function loopValues(values: string): string[] {
  const isSceneRange = /^\{0?1\.\.0?3\}$/u.test(values);
  const isSceneSequence = /^\$\(seq\s+(?:-w\s+)?1\s+3\)$/u.test(values);

  if (isSceneRange || isSceneSequence) {
    return values.startsWith("{0") ? ["01", "02", "03"] : ["1", "2", "3"];
  }

  return values.split(/\s+/u).filter((value) => /^0?[123]$/u.test(value));
}

function expandLoopArgument(
  argument: string,
  variable: string,
  value: string,
): string {
  return argument
    .replaceAll(`\${${variable}}`, value)
    .replace(new RegExp(`\\$${variable}(?!\\w)`, "gu"), value);
}

function piperInvocations(calls: readonly ObservedCall[]): PiperInvocation[] {
  const invocations: PiperInvocation[] = [];
  const addSceneInvocation = (out: string, textFile: string, voice: string) => {
    const scene = /(?:^|\/)scene-0?([123])-piper(?:-v\d+)?$/u.exec(out)?.[1];
    const matchesSceneText =
      scene && new RegExp(`(?:^|/)scene-0?${scene}\\.txt$`, "u").test(textFile);

    if (matchesSceneText) {
      invocations.push({ out, textFile, voice });
    }
  };

  for (const call of calls) {
    if (
      call.name !== "bash" ||
      call.status !== "completed" ||
      typeof call.input.command !== "string"
    ) {
      continue;
    }

    const command = call.input.command.replace(/\\\r?\n/gu, " ");
    // Разделяем отдельные запуски, чтобы --out соседней команды не засчитался синтезу.
    let position = 0;
    for (const invocation of command.split(/(?=python3?\s)/u)) {
      const invocationAt = position;
      position += invocation.length;
      const runsPiperScript = /python3?\s+[^;\n]*piper_speak\.py\b/u.test(
        invocation,
      );
      const hasTextFile = /--text-file\b/u.test(invocation);
      const hasVoice = /--voice\b/u.test(invocation);

      if (!runsPiperScript || !hasTextFile || !hasVoice) {
        continue;
      }

      const output = shellArgument(invocation, "out");
      const textFile = shellArgument(invocation, "text-file");
      const voice = shellArgument(invocation, "voice");
      if (!output || !textFile || !voice) {
        continue;
      }

      addSceneInvocation(output, textFile, voice);

      // Обычный пакетный запуск из навыка: for i in 01 02 03; do … scene-${i}-piper.
      const loops = command.matchAll(
        /\bfor\s+([a-zA-Z_]\w*)\s+in\s+([^;\n]+)[;\n]\s*do\b[\s\S]*?\bdone\b/gu,
      );
      for (const loop of loops) {
        const isInsideLoop =
          invocationAt >= loop.index &&
          invocationAt < loop.index + loop[0].length;
        if (!isInsideLoop) {
          continue;
        }

        for (const value of loopValues(loop[2].trim())) {
          addSceneInvocation(
            expandLoopArgument(output, loop[1], value),
            expandLoopArgument(textFile, loop[1], value),
            expandLoopArgument(voice, loop[1], value),
          );
        }
      }
    }
  }

  return invocations;
}

/** Проверяет вызовы по текстовым файлам сцен; stubs не исполняют shell. */
export function piperOutputPaths(calls: readonly ObservedCall[]): string[] {
  return [...new Set(piperInvocations(calls).map(({ out }) => out))].sort();
}

export function piperScenes(calls: readonly ObservedCall[]): number[] {
  const scenes = piperOutputPaths(calls).map((path) =>
    Number(/scene-0?([123])-piper/u.exec(path)![1]),
  );
  return [...new Set(scenes)].sort();
}

function synthesisOutputs(call: ObservedCallResult): unknown[] {
  if (!record(call.output)) {
    return [];
  }

  const outputs: unknown[] = call.name === "speak" ? [call.output] : [];
  if (
    call.name !== "bash" ||
    typeof call.input.command !== "string" ||
    !call.input.command.includes("piper_speak.py") ||
    typeof call.output.stdout !== "string" ||
    call.output.exitCode !== 0
  ) {
    return outputs;
  }

  for (const line of call.output.stdout.split("\n")) {
    try {
      outputs.push(JSON.parse(line));
    } catch {
      // Остальные строки не являются квитанциями синтеза.
    }
  }

  return outputs;
}

function piperInvocationForTimings(
  call: ObservedCall,
  timingsPath: string,
): PiperInvocation | undefined {
  const command =
    typeof call.input.command === "string" ? call.input.command : "";
  const directory = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))/u.exec(command);
  const cwd = posix.resolve(
    "/workspace",
    directory?.[1] ?? directory?.[2] ?? directory?.[3] ?? ".",
  );
  return piperInvocations([call]).find(
    ({ out }) => `${posix.resolve(cwd, out)}.words.json` === timingsPath,
  );
}

function validatedSynthesis(
  call: ObservedCallResult,
  output: unknown,
): SynthesisReceipt | undefined {
  if (
    !record(output) ||
    typeof output.audioPath !== "string" ||
    typeof output.timingsPath !== "string" ||
    typeof output.durationMs !== "number" ||
    !Number.isFinite(output.durationMs) ||
    output.durationMs <= 0
  ) {
    return undefined;
  }

  const extension = call.name === "speak" ? ".mp3" : ".wav";
  const basePath = output.audioPath.slice(0, -extension.length);
  if (
    !output.audioPath.endsWith(extension) ||
    output.timingsPath !== `${basePath}.words.json`
  ) {
    return undefined;
  }

  const scene = /\/scene-0?([123])(?:-piper)?(?:-v\d+)?\.words\.json$/u.exec(
    output.timingsPath,
  )?.[1];
  const common = {
    timingsPath: output.timingsPath,
    durationMs: output.durationMs,
  };

  if (call.name === "speak") {
    if (
      typeof call.input.text !== "string" ||
      typeof output.text !== "string" ||
      output.text.trim() !== call.input.text.trim() ||
      output.text.trim().length === 0 ||
      typeof output.voice !== "string" ||
      output.voice.length === 0 ||
      (call.input.voice !== undefined && call.input.voice !== output.voice) ||
      (call.input.outputPath !== undefined &&
        typeof call.input.outputPath !== "string")
    ) {
      return undefined;
    }

    // Без outputPath имя выбирает speak; проверяем пару, не выдумывая callId.
    const requested = resolveSpeechOutputPath(
      call.input.outputPath ?? basePath,
      "",
    );
    if (!requested.ok || requested.basePath !== basePath) {
      return undefined;
    }

    const text = output.text.trim();
    const sceneNumber = scene
      ? Number(scene)
      : data.scenes.findIndex((item) => item.text === text) + 1;
    if (sceneNumber === 0) {
      return undefined;
    }
    return { ...common, scene: sceneNumber, voice: output.voice, text };
  }

  const invocation = piperInvocationForTimings(call, output.timingsPath);
  if (!invocation || !scene) {
    return undefined;
  }
  const sceneNumber = Number(scene);
  return {
    ...common,
    scene: sceneNumber,
    voice: `piper:${invocation.voice}`,
    text: data.scenes[sceneNumber - 1].text,
  };
}

function readSceneTiming(
  call: ObservedCallResult,
  produced: ReadonlyMap<string, SynthesisTiming>,
): { scene: number; voice: string } | undefined {
  if (
    call.name !== "read_file" ||
    typeof call.input.filePath !== "string" ||
    !record(call.output) ||
    typeof call.output.path !== "string" ||
    typeof call.output.content !== "string"
  ) {
    return undefined;
  }

  const path = posix.resolve("/workspace", call.input.filePath);
  const synthesis = produced.get(path);
  if (synthesis === undefined || call.output.path !== path) {
    return undefined;
  }

  try {
    const timing: unknown = JSON.parse(
      call.output.content.replace(/^\d+: ?/gmu, ""),
    );
    if (
      record(timing) &&
      timing.durationMs === synthesis.durationMs &&
      timing.voice === synthesis.voice &&
      typeof timing.text === "string" &&
      timing.text.trim() === synthesis.text &&
      Array.isArray(timing.words) &&
      timing.words.length > 0 &&
      typeof timing.voice === "string"
    ) {
      return { scene: synthesis.scene, voice: timing.voice };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/** Тайминги прочитаны после синтеза и относятся именно к возвращённым файлам. */
export function sceneTimingsAfterSynthesis(
  calls: readonly ObservedCallResult[],
): number[] {
  const produced = new Map<string, SynthesisTiming>();
  const read = new Map<number, string>();
  const latestTimings = new Map<number, string>();

  for (const call of calls) {
    if (call.status !== "completed" || !record(call.output)) {
      continue;
    }

    for (const output of synthesisOutputs(call)) {
      const synthesis = validatedSynthesis(call, output);
      if (!synthesis) {
        continue;
      }

      const previousPath = latestTimings.get(synthesis.scene);
      if (previousPath && previousPath !== synthesis.timingsPath) {
        produced.delete(previousPath);
      }
      latestTimings.set(synthesis.scene, synthesis.timingsPath);
      read.delete(synthesis.scene);
      produced.set(synthesis.timingsPath, synthesis);
    }

    const timing = readSceneTiming(call, produced);
    if (timing) {
      read.set(timing.scene, timing.voice);
    }
  }

  return new Set(read.values()).size === 1 ? [...read.keys()].sort() : [];
}
