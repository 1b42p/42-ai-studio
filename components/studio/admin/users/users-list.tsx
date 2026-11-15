"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminUserItem } from "@/lib/admin/types";
import { initials } from "./format";
import { FormattedDate, UserStatusBadges } from "./user-status";
import { UserActionsMenu } from "./user-actions-menu";
import type { UserActionKind } from "./use-user-actions";

export interface UsersListProps {
  readonly items: readonly AdminUserItem[];
  onAction: (kind: UserActionKind, user: AdminUserItem) => void;
  /** Для проверок: без них берётся текущий момент и пояс браузера. */
  readonly now?: Date;
  readonly timeZone?: string;
}

function UserIdentity({ user }: { user: AdminUserItem }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar className="size-8 shrink-0">
        {user.photoUrl !== null ? <AvatarImage alt="" src={user.photoUrl} /> : null}
        <AvatarFallback>{initials(user.name)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium" title={user.name}>
          {user.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {user.username === null ? "Нет @username" : `@${user.username}`}
        </span>
      </div>
    </div>
  );
}

/** Таблица на компьютере и карточки на телефоне: одни и те же поля. */
export function UsersList({ items, onAction, now, timeZone }: UsersListProps) {
  return (
    <>
      <div className="hidden md:block">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[30%]">Пользователь</TableHead>
              <TableHead className="w-[13%]">Telegram ID</TableHead>
              <TableHead className="w-[8%]">Сессий</TableHead>
              <TableHead className="w-[12%]">Первый вход</TableHead>
              <TableHead className="w-[12%]">Последний вход</TableHead>
              <TableHead className="w-[17%]">Статус</TableHead>
              <TableHead className="w-[8%] text-right">
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="min-w-0">
                  <UserIdentity user={user} />
                </TableCell>
                <TableCell className="truncate text-muted-foreground">
                  {user.telegramId}
                </TableCell>
                <TableCell>{user.sessionCount}</TableCell>
                <TableCell className="text-muted-foreground">
                  {user.lastLoginAt === null ? (
                    "—"
                  ) : (
                    <FormattedDate now={now} timeZone={timeZone} value={user.createdAt} />
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <FormattedDate now={now} timeZone={timeZone} value={user.lastLoginAt} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <UserStatusBadges user={user} />
                </TableCell>
                <TableCell className="text-right">
                  <UserActionsMenu onAction={onAction} user={user} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ItemGroup className="md:hidden">
        {items.map((user) => (
          <Item key={user.id} role="listitem" variant="outline">
            <ItemMedia>
              <Avatar className="size-9">
                {user.photoUrl !== null ? <AvatarImage alt="" src={user.photoUrl} /> : null}
                <AvatarFallback>{initials(user.name)}</AvatarFallback>
              </Avatar>
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full min-w-0 truncate" title={user.name}>
                {user.name}
              </ItemTitle>
              <ItemDescription>
                {user.username === null ? "Нет @username" : `@${user.username}`}
              </ItemDescription>
              <ItemDescription>Telegram ID: {user.telegramId}</ItemDescription>
              <ItemDescription>Сессий: {user.sessionCount}</ItemDescription>
              {user.lastLoginAt === null ? null : (
                <ItemDescription>
                  Первый вход:{" "}
                  <FormattedDate now={now} timeZone={timeZone} value={user.createdAt} />
                </ItemDescription>
              )}
              <ItemDescription>
                Последний вход:{" "}
                <FormattedDate now={now} timeZone={timeZone} value={user.lastLoginAt} />
              </ItemDescription>
              <div className="pt-1">
                <UserStatusBadges user={user} />
              </div>
            </ItemContent>
            <ItemActions>
              <UserActionsMenu onAction={onAction} user={user} />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </>
  );
}
