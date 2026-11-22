/** Состояние файлов беседы и разрешение по паре «сообщение, путь» (#8). */
import type { SandboxFileResolver, SandboxFileStatus } from "@/components/studio/media/sandbox-file";
import type { MessageFileView } from "@/lib/media/types";

/** Файлы, которые видит беседа: строки `/api/sessions/:id/files` и ход. */
export interface MessageFilesState {
  readonly entries: readonly MessageFileView[];
  /** Сообщения идущего (или только что закончившегося) хода: строки может не быть. */
  readonly pendingMessageIds?: readonly string[];
  /** `false` — копия агента (#12): файлы не разрешаются, выводится путь. */
  readonly enabled?: boolean;
}

export function messageFileKey(messageId: string, path: string): string {
  return `${messageId}\u0000${path}`;
}

/** Разрешение файлов для всех сообщений беседы. */
export interface FileLookup {
  resolve(messageId: string | undefined, stepId?: string): SandboxFileResolver;
}

/** Индекс строк по паре «сообщение, путь»; неизвестный путь — заглушка. */
export function buildFileLookup(state: MessageFilesState | undefined): FileLookup {
  if (state?.enabled === false) {
    return { resolve: () => ({ kind: "disabled" }) };
  }

  const index = new Map(
    (state?.entries ?? []).map((entry) => [messageFileKey(entry.messageId, entry.path), entry]),
  );
  const versionedSteps = new Set(
    (state?.entries ?? []).flatMap(({ messageId }) => {
      const match = /^(.*):[a-f0-9]{64}$/.exec(messageId);
      return match ? [match[1]!] : [];
    }),
  );
  const pending = new Set(state?.pendingMessageIds ?? []);
  // Один и тот же объект для сообщения: стабильное значение контекста не
  // заставляет компоненты ссылок перерисовываться без причины.
  const cache = new Map<string, SandboxFileResolver>();

  return {
    resolve(messageId, stepId) {
      const key = messageId ?? (stepId === undefined ? undefined : `${stepId}:streaming`);
      if (state === undefined || key === undefined) return { kind: "unavailable" };
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const resolver: SandboxFileResolver = {
        kind: "lookup",
        status(path): SandboxFileStatus {
          const entry = messageId === undefined ? undefined :
            index.get(messageFileKey(messageId, path)) ??
            (stepId !== undefined && !versionedSteps.has(stepId) ? index.get(messageFileKey(stepId, path)) : undefined);
          if (entry !== undefined) return { kind: "entry", entry };
          if (pending.has(stepId ?? key)) return { kind: "pending" };
          return { kind: "unknown" };
        },
      };
      cache.set(key, resolver);
      return resolver;
    },
  };
}
