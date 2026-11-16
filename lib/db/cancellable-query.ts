/** Отмена самого запроса Postgres, без продолжающейся после дедлайна записи. */
export async function cancellableQuery<T>(
  pending: PromiseLike<T> & { cancel(): void },
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const abort = () => pending.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await pending;
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
