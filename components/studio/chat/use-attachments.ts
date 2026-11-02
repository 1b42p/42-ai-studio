"use client";

/**
 * Загрузка вложений (#9): строка `media` через `POST /api/uploads`, затем
 * `PUT` файла прямо в S3 через `XMLHttpRequest` (нужны события прогресса).
 * Не больше трёх загрузок одновременно; ошибка блокирует отправку до
 * «Повторить» или «Убрать».
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  attachmentName,
  selectAttachableFiles,
  type AttachmentsController,
  type PendingAttachment,
} from "@/components/studio/chat/attachments";
import { isImageType } from "@/components/studio/chat/attachment-kind";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/uploads/limits";
import { uploadOriginalName } from "@/lib/uploads/name";
import type { UploadTicket } from "@/lib/uploads/types";

const MAX_PARALLEL_UPLOADS = 3;

export interface UseAttachmentsOptions {
  /** Сессия приложения; `null` — её ещё нужно создать перед первую загрузку. */
  appSessionId: string | null;
  /** Создаёт сессию приложения (страница `/s`) и возвращает её id. */
  ensureSession?: () => Promise<string>;
}

async function errorMessageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === "string" && message.length > 0 ? message : UPLOAD_FAILED_MESSAGE;
  } catch {
    return UPLOAD_FAILED_MESSAGE;
  }
}

export function useAttachments({
  appSessionId,
  ensureSession,
}: UseAttachmentsOptions): AttachmentsController {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string>();

  const itemsRef = useRef<PendingAttachment[]>(items);
  const filesRef = useRef(new Map<string, File>());
  const queueRef = useRef<string[]>([]);
  const activeRef = useRef(0);
  const pumpingRef = useRef(false);
  const cancelledRef = useRef(new Set<string>());
  const xhrsRef = useRef(new Map<string, XMLHttpRequest>());
  const sessionIdRef = useRef(appSessionId);
  const ensureSessionRef = useRef(ensureSession);

  useEffect(() => {
    sessionIdRef.current = appSessionId;
  }, [appSessionId]);

  useEffect(() => {
    ensureSessionRef.current = ensureSession;
  }, [ensureSession]);

  const replaceItems = useCallback(
    (update: (current: PendingAttachment[]) => PendingAttachment[]) => {
      // Список обновляется и в ref сразу: `addFiles` ставит загрузки в очередь
      // в той же обработке события, а `upload` читает состояние из ref.
      const next = update(itemsRef.current);
      itemsRef.current = next;
      setItems(next);
    },
    [],
  );

  const patch = useCallback(
    (id: string, changes: Partial<PendingAttachment>) => {
      replaceItems((current) =>
        current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
      );
    },
    [replaceItems],
  );

  const upload = useCallback(
    async (id: string): Promise<void> => {
      const file = filesRef.current.get(id);
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (file === undefined || item === undefined) return;

      patch(id, { state: "uploading", progress: 0, error: undefined });

      const fail = (message: string) => {
        if (cancelledRef.current.has(id)) return;
        patch(id, { state: "error", error: message, progress: 0 });
      };

      let sessionId = sessionIdRef.current;
      try {
        if (sessionId === null) {
          const ensure = ensureSessionRef.current;
          if (ensure === undefined) throw new Error(UPLOAD_FAILED_MESSAGE);
          sessionId = await ensure();
          sessionIdRef.current = sessionId;
        }
      } catch (error) {
        fail(error instanceof Error && error.message.length > 0 ? error.message : UPLOAD_FAILED_MESSAGE);
        return;
      }

      let ticket: UploadTicket;
      try {
        const response = await fetch("/api/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appSessionId: sessionId,
            name: item.name,
            contentType: item.contentType,
            sizeBytes: item.sizeBytes,
          }),
        });
        if (!response.ok) {
          fail(await errorMessageOf(response));
          return;
        }
        ticket = (await response.json()) as UploadTicket;
      } catch {
        fail(UPLOAD_FAILED_MESSAGE);
        return;
      }

      if (cancelledRef.current.has(id)) return;

      await new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhrsRef.current.set(id, xhr);
        const done = () => {
          xhrsRef.current.delete(id);
          resolve();
        };

        xhr.open(ticket.method, ticket.uploadUrl);
        for (const [name, value] of Object.entries(ticket.headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable || event.total === 0) return;
          const progress = Math.min(100, Math.round((event.loaded / event.total) * 100));
          patch(id, { progress });
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            if (!cancelledRef.current.has(id)) {
              patch(id, {
                state: "done",
                progress: 100,
                mediaId: ticket.id,
                fileUrl: ticket.fileUrl,
              });
            }
          } else {
            fail(UPLOAD_FAILED_MESSAGE);
          }
          done();
        };
        xhr.onerror = () => {
          fail(UPLOAD_FAILED_MESSAGE);
          done();
        };
        xhr.onabort = () => {
          done();
        };
        xhr.send(file);
      });
    },
    [patch],
  );

  /** Запускает загрузки из очереди, пока не набралось три одновременных. */
  const pump = useCallback(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    void (async () => {
      try {
        while (activeRef.current < MAX_PARALLEL_UPLOADS && queueRef.current.length > 0) {
          const id = queueRef.current.shift();
          if (id === undefined) break;
          activeRef.current += 1;
          void upload(id).finally(() => {
            activeRef.current -= 1;
            pump();
          });
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  }, [upload]);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const existing = itemsRef.current;
      const selection = selectAttachableFiles(existing, files);
      if (selection.notice !== undefined) setNotice(selection.notice);
      else setNotice(undefined);

      const added: PendingAttachment[] = [];
      for (const file of selection.accepted) {
        const id = crypto.randomUUID();
        const contentType = file.type.toLowerCase();
        const previewUrl =
          isImageType(contentType) && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined;
        filesRef.current.set(id, file);
        added.push({
          id,
          name: uploadOriginalName(attachmentName(file)),
          contentType,
          sizeBytes: file.size,
          state: "uploading",
          progress: 0,
          previewUrl,
        });
        queueRef.current.push(id);
      }

      if (added.length > 0) replaceItems((current) => [...current, ...added]);
      pump();
    },
    [pump, replaceItems],
  );

  const remove = useCallback(
    (id: string) => {
      cancelledRef.current.add(id);
      queueRef.current = queueRef.current.filter((candidate) => candidate !== id);
      const xhr = xhrsRef.current.get(id);
      if (xhr !== undefined) {
        xhrsRef.current.delete(id);
        xhr.abort();
      }
      filesRef.current.delete(id);
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (item?.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
      replaceItems((current) => current.filter((candidate) => candidate.id !== id));
      setNotice(undefined);
    },
    [replaceItems],
  );

  const retry = useCallback(
    (id: string) => {
      if (!filesRef.current.has(id)) return;
      cancelledRef.current.delete(id);
      patch(id, { state: "uploading", progress: 0, error: undefined });
      queueRef.current.push(id);
      pump();
    },
    [patch, pump],
  );

  const clear = useCallback(() => {
    for (const id of xhrsRef.current.keys()) cancelledRef.current.add(id);
    for (const xhr of xhrsRef.current.values()) xhr.abort();
    xhrsRef.current.clear();
    for (const item of itemsRef.current) {
      if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
    }
    filesRef.current.clear();
    queueRef.current = [];
    setNotice(undefined);
    replaceItems(() => []);
  }, [replaceItems]);

  useEffect(
    () => () => {
      for (const xhr of xhrsRef.current.values()) xhr.abort();
      xhrsRef.current.clear();
      for (const item of itemsRef.current) {
        if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  const blocking = items.some((item) => item.state === "uploading" || item.state === "error");

  return { items, blocking, notice, addFiles, remove, retry, clear };
}
