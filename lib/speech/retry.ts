import { isAbortError } from "./errors";

export interface RetrySpeechOptions {
  /** Паузы между попытками. Число попыток — на одну больше. */
  readonly pausesMs: readonly number[];
  readonly signal?: AbortSignal;
  readonly isRetryable: (error: unknown) => boolean;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal ?? new AbortController().signal));
    };
    if (signal === undefined) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(abortError(signal));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Повтор операции. Отмена не повторяется и не подменяется текстом инструмента. */
export async function retrySpeech<T>(
  operation: () => Promise<T>,
  options: RetrySpeechOptions,
): Promise<T> {
  const attempts = options.pausesMs.length + 1;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return await operation();
    } catch (error) {
      last = error;
      const finished = attempt === attempts - 1;
      if (isAbortError(error) || finished || !options.isRetryable(error)) throw error;
      await sleepAbortable(options.pausesMs[attempt] ?? 0, options.signal);
    }
  }
  throw last;
}
