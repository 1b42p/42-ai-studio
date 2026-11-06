import type { EvalReporter } from "eve/evals/reporters";
import { isUnresolvedCheckpoint, type CheckpointStore } from "./checkpoint-store.mjs";

export function createCheckpointReporter(store: CheckpointStore, judgeFingerprint: string): EvalReporter {
  return {
    async onRunStart(evaluations, target) {
      await store.initialize({ target: target.url, caseIds: evaluations.map(({ id }) => id) });
      await store.assertNotBlocked();
      const response = await fetch(new URL("api/health", target.url), { signal: AbortSignal.timeout(10_000), redirect: "error" });
      const runtime = response.headers.get("x-studio-eval-runtime");
      if (!response.ok || !runtime || !/^[a-f0-9]{64}$/.test(runtime)) {
        throw new Error("Не удалось определить конфигурацию локального eval-сервера.");
      }
      await store.bindRuntime(`${runtime}:${judgeFingerprint}`);
    },
    async onEvalComplete(result) {
      if (isUnresolvedCheckpoint(result)) return;
      await store.writeResult(result);
    },
    onRunComplete() {},
  };
}
