"use client";

import {
  BanIcon,
  CircleCheckIcon,
  EllipsisVerticalIcon,
  Trash2Icon,
} from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AdminUserItem } from "@/lib/admin/types";
import type { UserActionKind } from "./use-user-actions";

const OPERATOR_HINT = "Оператора нельзя заблокировать или удалить";
const DELETING_HINT = "Пользователь удаляется, разблокировать нельзя.";

export function UserActionsMenu({
  user,
  onAction,
}: {
  user: AdminUserItem;
  onAction: (kind: UserActionKind, user: AdminUserItem) => void;
}) {
  const reasonId = useId();
  const blockKind: UserActionKind = user.isBlocked ? "unblock" : "block";
  const blockLabel = user.isBlocked ? "Разблокировать" : "Заблокировать";
  const blockReason = user.isOperator
    ? OPERATOR_HINT
    : user.deletionRequestedAt !== null
      ? DELETING_HINT
      : null;
  const deleteLabel = user.deletionRequestedAt !== null ? "Продолжить удаление" : "Удалить";
  const deleteReason = user.isOperator ? OPERATOR_HINT : null;
  const reason = blockReason ?? deleteReason;

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
      <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]" aria-describedby={reason ? reasonId : undefined}>
        <DropdownMenuGroup>
          {reason ? (
            <DropdownMenuLabel id={reasonId} className="max-w-64 whitespace-normal">
              {reason}
            </DropdownMenuLabel>
          ) : null}
          {blockReason === null ? (
            <DropdownMenuItem onClick={() => onAction(blockKind, user)}>
              {user.isBlocked ? <CircleCheckIcon /> : <BanIcon />}
              {blockLabel}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled aria-describedby={reasonId}>
              {user.isBlocked ? <CircleCheckIcon /> : <BanIcon />}
              {blockLabel}
            </DropdownMenuItem>
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
            <DropdownMenuItem disabled aria-describedby={reasonId}>
              <Trash2Icon />
              {deleteLabel}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
