import { ArrowUpRightIcon, ClapperboardIcon, CodeIcon, SendIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type LoginError = "blocked" | "failed" | null;

export interface LoginCardProps {
  next: string;
  telegramEnabled: boolean;
  devLoginEnabled: boolean;
  error: LoginError;
}

/**
 * Содержимое страницы входа. Отдельный компонент без серверных зависимостей:
 * его отрисовывают тесты без маршрутизатора.
 */
export function LoginCard({
  next,
  telegramEnabled,
  devLoginEnabled,
  error,
}: LoginCardProps) {
  const nothingConfigured = !telegramEnabled && !devLoginEnabled;

  return (
    <Card className="w-full max-w-3xl gap-0 overflow-hidden rounded-3xl py-0 md:grid md:grid-cols-2 [&_:focus-visible]:ring-foreground [&_:focus-visible]:outline-foreground">
      <CardHeader className="relative flex flex-col justify-between gap-8 overflow-hidden rounded-none border-b bg-primary/8 p-7 md:min-h-96 md:border-r md:border-b-0 md:p-10">
        <Badge variant="outline" className="w-fit gap-2"><ClapperboardIcon />42 AI Studio</Badge>
        <span aria-hidden="true" className="pointer-events-none absolute -right-5 top-4 select-none text-[13rem] font-semibold leading-none tracking-tighter text-primary/8 md:top-20">42</span>
        <div className="relative flex flex-col gap-3">
          <CardTitle className="text-4xl font-semibold tracking-tight">Вход</CardTitle>
          <CardDescription className="max-w-60 text-base leading-relaxed">Войдите через Telegram, отдельный аккаунт не нужен</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col justify-center gap-5 p-7 md:p-10">
        {error === "blocked" ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Доступ закрыт</AlertTitle>
            <AlertDescription>
              Доступ к сервису закрыт для этого аккаунта. Если это ошибка, напишите владельцу
              сервиса.
            </AlertDescription>
          </Alert>
        ) : null}

        {error === "failed" ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Не удалось войти</AlertTitle>
            <AlertDescription>
              Не удалось войти через Telegram. Вход мог быть отменён или устареть, попробуйте ещё
              раз.
            </AlertDescription>
          </Alert>
        ) : null}

        {nothingConfigured ? (
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>Вход не настроен</AlertTitle>
            <AlertDescription>
              Владельцу сервиса нужно настроить вход через Telegram.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          {telegramEnabled ? (
            <a
              href={`/api/auth/telegram/login?next=${encodeURIComponent(next)}`}
              className={buttonVariants({ size: "lg", className: "w-full justify-between" })}
            >
              <span className="flex items-center gap-2"><SendIcon data-icon="inline-start" />Войти через Telegram</span>
              <ArrowUpRightIcon data-icon="inline-end" />
            </a>
          ) : null}

          {devLoginEnabled ? (
            <a
              href={`/api/auth/dev-login?telegramId=1&name=${encodeURIComponent("Разработчик")}`}
              className={buttonVariants({ variant: "outline", size: "lg", className: "w-full" })}
            >
              <CodeIcon data-icon="inline-start" />
              Войти как разработчик
            </a>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
