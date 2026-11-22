"use client";

import { AlertCircleIcon, LogOutIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup } from "@/components/ui/field";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { initialsOf } from "@/components/studio/user-menu";
import { useLogout } from "@/components/studio/use-logout";

import { useSettingsAccount } from "./account-context";

export function AccountSection() {
  const { user, onLogout } = useSettingsAccount();
  const { pending, failed, logout } = useLogout(onLogout);

  return (
    <FieldGroup>
      <Item variant="muted" className="min-w-0">
        <ItemMedia>
          <Avatar size="lg">
            {user.photoUrl !== null ? <AvatarImage src={user.photoUrl} alt="" /> : null}
            <AvatarFallback>{initialsOf(user.name)}</AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="max-w-full truncate">{user.name}</ItemTitle>
          {user.username !== null ? (
            <ItemDescription className="truncate">@{user.username}</ItemDescription>
          ) : null}
        </ItemContent>
      </Item>
      {failed ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>Не удалось выйти. Попробуйте ещё раз.</AlertDescription>
        </Alert>
      ) : null}
      <Field>
        <Button
          aria-label="Выйти"
          aria-busy={pending}
          variant="outline"
          className="w-full sm:w-fit"
          disabled={pending}
          onClick={() => void logout()}
        >
          {pending ? (
            <Spinner data-icon="inline-start" aria-label="Выход" />
          ) : (
            <LogOutIcon data-icon="inline-start" />
          )}
          Выйти
        </Button>
      </Field>
    </FieldGroup>
  );
}
