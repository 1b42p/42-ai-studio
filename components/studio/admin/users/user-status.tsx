"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import type { AdminUserItem } from "@/lib/admin/types";
import { formatSessionDate } from "@/lib/sessions/format-date";

/** Дата форматируется после монтирования: пояс браузера неизвестен серверу. */
export function FormattedDate({
  value,
  now,
  timeZone,
}: {
  value: string | null;
  now?: Date;
  timeZone?: string;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (value === null) {
      setText("—");
      return;
    }
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    setText(formatSessionDate(new Date(value), now ?? new Date(), zone));
  }, [now, timeZone, value]);

  return <span>{text}</span>;
}

export function UserStatusBadges({ user }: { user: AdminUserItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {user.isOperator ? <Badge variant="secondary">Оператор</Badge> : null}
      {user.deletionRequestedAt !== null ? (
        <Badge variant="destructive">Удаляется</Badge>
      ) : user.isBlocked ? (
        <Badge variant="outline">Заблокирован</Badge>
      ) : null}
      {user.stuckDeletions > 0 ? (
        <Badge variant="destructive">Застряло удалений: {user.stuckDeletions}</Badge>
      ) : null}
    </div>
  );
}
