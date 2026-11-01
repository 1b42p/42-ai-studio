/** SDK methods without transport cancellation still stop the caller's wait. */
export async function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return operation();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Операция отменена", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
