import { ClockIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import type { SandboxStatus } from "@/lib/sandbox/status";

export function SandboxStatusBanner({ status }: { status?: SandboxStatus | null }) {
  let text: string;
  if (status?.state === "starting") {
    text = "Запускаем песочницу…";
  } else if (status?.state === "queued" && status.queue !== null) {
    text = status.queue.reason === "own_session_busy"
      ? "Идёт работа в другой вашей сессии. Эта сессия продолжит работу, когда та закончит."
      : `Все песочницы заняты. Ваше место в очереди: ${status.queue.position} из ${status.queue.total}. Сессия продолжит работу сама; если ожидание затянется и придёт ошибка, отправьте сообщение ещё раз.`;
  } else {
    return null;
  }

  return (
    <Alert aria-label="Состояние песочницы" aria-live="polite" role="status">
      {status.state === "starting" ? <Spinner aria-hidden="true" /> : <ClockIcon aria-hidden="true" />}
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}
