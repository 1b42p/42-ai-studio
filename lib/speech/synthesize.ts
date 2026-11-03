import type { SynthesisResult } from "@andresaya/edge-tts";

import { textCoverage } from "./coverage";
import { SPEECH_OUTPUT_FORMAT, SPEECH_TIMEOUT_MS } from "./client";
import {
  isRetryableSpeechError,
  logSpeechFailure,
  mapSpeechFailure,
  SpeechIncompleteError,
  speechError,
} from "./errors";
import { retrySpeech } from "./retry";
import { mp3DurationMs } from "./time";
import { buildTimings, speechIsComplete, type TimingsFile } from "./timings";

export interface SynthesizeRequest {
  readonly text: string;
  readonly voice: string;
  readonly language: string;
  readonly voiceExplicit: boolean;
  readonly rate: number;
  readonly signal?: AbortSignal;
  readonly pausesMs: readonly number[];
  readonly generate: (
    text: string,
    voice: string,
    options: {
      readonly rate: number;
      readonly outputFormat: string;
      readonly signal?: AbortSignal;
      readonly timeout: number;
    },
  ) => Promise<Pick<SynthesisResult, "audio" | "wordBoundaries" | "sentenceBoundaries">>;
}

export interface SynthesizeOutcome {
  readonly audio: Uint8Array;
  readonly timings: TimingsFile;
  readonly durationMs: number;
}

/**
 * Синтез с повторами. Неполная озвучка повторяется, непрочитанный текст — нет.
 * Наружу выходит уже текст инструмента, кроме отмены хода.
 */
export async function synthesizeSpeech(request: SynthesizeRequest): Promise<SynthesizeOutcome> {
  try {
    return await retrySpeech(
      async () => {
        let result: Pick<SynthesisResult, "audio" | "wordBoundaries" | "sentenceBoundaries">;
        try {
          result = await request.generate(request.text, request.voice, {
            rate: request.rate,
            outputFormat: SPEECH_OUTPUT_FORMAT,
            signal: request.signal,
            timeout: SPEECH_TIMEOUT_MS,
          });
        } catch (error) {
          logSpeechFailure(error);
          throw error;
        }

        const durationMs = mp3DurationMs(result.audio.byteLength);
        const timings = buildTimings({
          source: request.text,
          voice: request.voice,
          language: request.language,
          durationMs,
          words: result.wordBoundaries,
          sentences: result.sentenceBoundaries,
        });
        if (!speechIsComplete(timings.sentences, durationMs)) {
          const error = new SpeechIncompleteError();
          logSpeechFailure(error);
          throw error;
        }
        if (textCoverage(request.text, result.wordBoundaries.map((word) => word.text)) === "unreadable") {
          throw speechError("speak_text_not_readable");
        }
        return { audio: result.audio, timings, durationMs };
      },
      {
        pausesMs: request.pausesMs,
        signal: request.signal,
        isRetryable: isRetryableSpeechError,
      },
    );
  } catch (error) {
    throw mapSpeechFailure(error, {
      voiceExplicit: request.voiceExplicit,
      voiceName: request.voice,
    });
  }
}
