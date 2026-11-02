"use client";

import { useCallback, useEffect, useState } from "react";

export interface MediaRetry {
  /** Адрес медиа; после первой ошибки — с `?retry=1`. */
  readonly src: string | undefined;
  /** Вторая ошибка: ссылка не восстановилась. */
  readonly failed: boolean;
  /** Обработчик `onError` элемента. */
  readonly onError: () => void;
}

/**
 * Одна повторная загрузка медиа после ошибки (#8): истёкшая ссылка обновляется
 * тем же адресом с `?retry=1`, который маршрут игнорирует. Повторная ошибка
 * означает «недоступно»: карточка показывает скачивание.
 */
export function useMediaRetry(mediaId: string | null | undefined): MediaRetry {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [mediaId]);

  const onError = useCallback(() => {
    if (attempt === 0) {
      setAttempt(1);
      return;
    }
    setFailed(true);
  }, [attempt]);

  const src =
    mediaId === null || mediaId === undefined
      ? undefined
      : `/api/media/${mediaId}${attempt > 0 ? "?retry=1" : ""}`;

  return { src, failed, onError };
}
