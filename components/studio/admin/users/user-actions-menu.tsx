"use client";

import {
  BanIcon,
  CircleCheckIcon,
  EllipsisVerticalIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AdminUserItem } from "@/lib/admin/types";
import type { UserActionKind } from "./use-user-actions";

const OPERATOR_HINT = "Оператора нельзя заблокировать или удалить";
const DELETING_HINT = "Пользователь удаляется, разблокировать нельзя.";

function DisabledItem({
  reason,
  children,
}: {
  reason: string;
  children: React.ReactNode;
}) {
  return (
    // У отключённого пункта меню нет наведения: подсказка живёт на обёртке.
    <span className="block" title={reason}>
      <DropdownMenuItem disabled>{children}</DropdownMenuItem>
    </span>
  );
}

export function UserActionsMenu({
  user,
  onAction,
}: {
  user: AdminUserItem;
  onAction: (kind: UserActionKind, user: AdminUserItem) => void;
}) {
  const blockKind: UserActionKind = user.isBlocked ? "unblock" : "block";
  const blockLabel = user.isBlocked ? "Разблокировать" : "Заблокировать";
  const blockReason = user.isOperator
    ? OPERATOR_HINT
    : user.deletionRequestedAt !== null
      ? DELETING_HINT
      : null;
  const deleteLabel = user.deletionRequestedAt !== null ? "Продолжить удаление" : "Удалить";
  const deleteReason = user.isOperator ? OPERATOR_HINT : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Действия для ${user.name}`}
            size="icon"
            type="button"
            variant="ghost"
          >
            <EllipsisVerticalIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {blockReason === null ? (
            <DropdownMenuItem onClick={() => onAction(blockKind, user)}>
              {user.isBlocked ? <CircleCheckIcon /> : <BanIcon />}
              {blockLabel}
            </DropdownMenuItem>
          ) : (
            <DisabledItem reason={blockReason}>
              {user.isBlocked ? <CircleCheckIcon /> : <BanIcon />}
              {blockLabel}
            </DisabledItem>
          )}
          <DropdownMenuSeparator />
          {deleteReason === null ? (
            <DropdownMenuItem
              onClick={() => onAction("delete", user)}
              variant="destructive"
            >
              <Trash2Icon />
              {deleteLabel}
            </DropdownMenuItem>
          ) : (
            <DisabledItem reason={deleteReason}>
              <Trash2Icon />
              {deleteLabel}
            </DisabledItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
