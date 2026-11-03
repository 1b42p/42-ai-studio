import { sleepAbortable } from "./retry";

/** Пауза между вызовами `speak` одной сессии: подряд сервис часто отвечает 429. */
export const SPEECH_MIN_INTERVAL_MS = 6_000;

interface Lane {
  tail: Promise<void>;
  finishedAt: number;
}

const lanes = new Map<string, Lane>();

/**
 * Держит замок на всё время синтеза и не пускает следующий вызов той же
 * сессии раньше, чем через `gapMs` после конца предыдущего.
 * Разные сессии друг друга не ждут.
 */
export async function withSpeechPace<T>(
  sessionId: string,
  gapMs: number,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const lane = lanes.get(sessionId) ?? { tail: Promise.resolve(), finishedAt: 0 };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = lane.tail;
  lane.tail = previous.then(() => gate);
  lanes.set(sessionId, lane);

  await previous;
  try {
    signal?.throwIfAborted();
    const wait = lane.finishedAt === 0 ? 0 : gapMs - (Date.now() - lane.finishedAt);
    if (wait > 0) await sleepAbortable(wait, signal);
    return await run();
  } finally {
    lane.finishedAt = Date.now();
    release();
  }
}
