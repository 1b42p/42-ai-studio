import { sleepAbortable } from "./retry";

/** Пауза между вызовами `speak` одной сессии: подряд сервис часто отвечает 429. */
export const SPEECH_MIN_INTERVAL_MS = 6_000;

interface Lane {
  tail: Promise<void>;
  /** Сколько вызовов ещё не вышло из `finally`. Растёт до первого ожидания. */
  waiters: number;
  finishedAt: number;
}

const lanes = new Map<string, Lane>();

/** Есть ли ещё очередь этой сессии. Нужна проверке, что простаивающая сессия уходит из памяти. */
export function hasSpeechLane(sessionId: string): boolean {
  return lanes.has(sessionId);
}

/**
 * Удаляет сессию только после паузы и только если с тех пор не пришёл новый вызов.
 * Таймер не держит процесс: при выходе карта всё равно исчезнет вместе с ним.
 */
function armEviction(sessionId: string, lane: Lane, gapMs: number, finishedAt: number): void {
  const delay = Math.max(0, finishedAt + gapMs - Date.now());
  const timer = setTimeout(() => {
    if (lanes.get(sessionId) !== lane || lane.waiters !== 0 || lane.finishedAt !== finishedAt) return;
    if (Date.now() < finishedAt + gapMs) {
      armEviction(sessionId, lane, gapMs, finishedAt);
      return;
    }
    lanes.delete(sessionId);
  }, delay);
  timer.unref();
}

/**
 * Держит замок на всё время синтеза и не пускает следующий вызов той же
 * сессии раньше, чем через `gapMs` после конца предыдущего.
 * Разные сессии друг друга не ждут. Сессия без очереди удаляется после паузы.
 */
export async function withSpeechPace<T>(
  sessionId: string,
  gapMs: number,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let lane = lanes.get(sessionId);
  if (lane === undefined) {
    lane = { tail: Promise.resolve(), waiters: 0, finishedAt: 0 };
    lanes.set(sessionId, lane);
  }
  lane.waiters += 1;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = lane.tail;
  lane.tail = previous.then(() => gate);

  try {
    await previous;
    signal?.throwIfAborted();
    const wait = lane.finishedAt === 0 ? 0 : gapMs - (Date.now() - lane.finishedAt);
    if (wait > 0) await sleepAbortable(wait, signal);
    return await run();
  } finally {
    lane.finishedAt = Date.now();
    release();
    lane.waiters -= 1;
    if (lane.waiters === 0) armEviction(sessionId, lane, gapMs, lane.finishedAt);
  }
}
