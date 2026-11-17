"use client";

import { useState } from "react";
import { CheckCircleIcon, GlobeIcon, LogOutIcon, PlusIcon, RefreshCwIcon, Trash2Icon, UnplugIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { useMcpContext, type McpCheck, type McpState } from "./mcp-context";

const AUTH_LABELS = { none: "Без авторизации", bearer: "Токен", headers: "Заголовки", oauth: "Вход через браузер" } as const;

function checkMessage(result: McpCheck): string {
  return result.ok
    ? `Подключение работает. Инструментов: ${result.toolCount}. ${result.tools.slice(0, 10).join(", ")}`
    : result.message;
}

export function McpSection() {
  const state = useMcpContext();
  return state ? <McpSectionView state={state} /> : null;
}

export function McpSectionView({ state }: { state: McpState }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authKind, setAuthKind] = useState<"none" | "bearer" | "headers" | "oauth">("none");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState([{ name: "", value: "" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось выполнить запрос."); }
    finally { setBusy(false); }
  };
  const selected = state.servers.find((server) => server.id === deleting);
  const errorField = /названи/i.test(error) ? "name"
    : /адрес|имя сервера не найдено|https/i.test(error) ? "url"
      : /токен/i.test(error) ? "token"
        : /заголов/i.test(error) ? "headers" : "general";

  return (
    <FieldGroup>
      <Button className="self-start" onClick={() => { setError(""); setOpen(true); }}>
        <PlusIcon data-icon="inline-start" /> Добавить сервер
      </Button>
      {error && !open && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {state.servers.length === 0 ? (
        <Empty className="rounded-xl border border-dashed bg-muted/25"><EmptyHeader><EmptyMedia variant="icon" className="bg-primary/10 text-foreground"><UnplugIcon /></EmptyMedia><EmptyDescription>Серверов пока нет</EmptyDescription></EmptyHeader></Empty>
      ) : <ItemGroup className="gap-3">{state.servers.map((server) => (
        <Item className="min-w-0 items-start rounded-xl border-border bg-muted/20 p-4" role="listitem" key={server.id}>
            <ItemContent className="min-w-0">
              <ItemTitle className="max-w-full truncate">{server.name}</ItemTitle>
              <ItemDescription className="truncate">{server.url}</ItemDescription>
              <Badge className="self-start" variant="secondary">
                {server.authKind === "oauth" && <GlobeIcon data-icon="inline-start" />}
                {AUTH_LABELS[server.authKind]}
              </Badge>
              {server.authKind === "oauth" && <Badge className="self-start" variant="outline">
                {server.connected ? <CheckCircleIcon data-icon="inline-start" /> : <UnplugIcon data-icon="inline-start" />}
                {server.connected ? "Подключён" : "Не подключён"}
              </Badge>}
            </ItemContent>
             <ItemActions className="flex-wrap">
             <Switch aria-label={`Включён: ${server.name}`} checked={server.enabled} onCheckedChange={(enabled) => void run(() => state.toggle(server.id, enabled))} />
             <Button size="icon" variant="ghost" aria-label={`Проверить ${server.name}`} onClick={() => void state.check(server.id)}><RefreshCwIcon /></Button>
             <Button size="icon" variant="ghost" aria-label={`Удалить ${server.name}`} onClick={() => setDeleting(server.id)}><Trash2Icon /></Button>
             {server.authKind === "oauth" && <Button size="icon" variant="ghost" disabled={busy || !server.connected}
               aria-label={`Сбросить вход: ${server.name}`} onClick={() => setSigningOut(server.id)}><LogOutIcon /></Button>}
            </ItemActions>
            {state.checks[server.id] && <ItemFooter><ItemDescription>{checkMessage(state.checks[server.id]!)}</ItemDescription></ItemFooter>}
        </Item>
      ))}</ItemGroup>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Добавить MCP-сервер</DialogTitle><DialogDescription>Укажите адрес и способ авторизации.</DialogDescription></DialogHeader>
          <FieldGroup>
            <Field data-invalid={error && errorField === "name" ? true : undefined}><FieldLabel htmlFor="mcp-name">Название</FieldLabel><Input id="mcp-name" aria-invalid={error && errorField === "name" ? true : undefined} value={name} onChange={(event) => setName(event.target.value)} />{errorField === "name" && <FieldError>{error}</FieldError>}</Field>
            <Field data-invalid={error && errorField === "url" ? true : undefined}><FieldLabel htmlFor="mcp-url">Адрес сервера</FieldLabel><Input id="mcp-url" aria-invalid={error && errorField === "url" ? true : undefined} placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />{errorField === "url" && <FieldError>{error}</FieldError>}</Field>
            <Field><FieldLabel htmlFor="mcp-auth">Авторизация</FieldLabel>
              <Select value={authKind} onValueChange={(value) => { if (value === "none" || value === "bearer" || value === "headers" || value === "oauth") setAuthKind(value); }}>
                <SelectTrigger id="mcp-auth"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="none">Без авторизации</SelectItem><SelectItem value="bearer">Токен (Bearer)</SelectItem><SelectItem value="headers">Свои заголовки</SelectItem><SelectItem value="oauth">Вход через браузер (OAuth)</SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
            {authKind === "oauth" && <FieldDescription>Вход выполнится в чате, когда агент впервые обратится к серверу</FieldDescription>}
            {authKind === "bearer" && <Field data-invalid={error && errorField === "token" ? true : undefined}><FieldLabel htmlFor="mcp-token">Токен</FieldLabel><Input id="mcp-token" aria-invalid={error && errorField === "token" ? true : undefined} type="password" value={token} onChange={(event) => setToken(event.target.value)} />{errorField === "token" && <FieldError>{error}</FieldError>}</Field>}
            {authKind === "headers" && <>
              {headers.map((header, index) => <Field orientation="horizontal" className="min-w-0" key={index}>
                <Input aria-label={`Имя заголовка ${index + 1}`} placeholder="Имя" value={header.name} onChange={(event) => setHeaders((current) => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />
                <Input aria-label={`Значение заголовка ${index + 1}`} placeholder="Значение" type="password" value={header.value} onChange={(event) => setHeaders((current) => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
                <Button size="icon" variant="ghost" aria-label={`Убрать заголовок ${index + 1}`} onClick={() => setHeaders((current) => current.filter((_, i) => i !== index))}><Trash2Icon /></Button>
              </Field>)}
              <Button variant="outline" onClick={() => setHeaders((current) => [...current, { name: "", value: "" }])} disabled={headers.length >= 10}>Добавить заголовок</Button>
              {errorField === "headers" && <FieldError>{error}</FieldError>}
            </>}
            {error && errorField === "general" && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          </FieldGroup>
          <DialogFooter><Button disabled={busy} onClick={() => void run(async () => {
            await state.add({
              name, url, authKind,
              ...(authKind === "bearer" ? { token } : {}),
              ...(authKind === "headers" ? { headers } : {}),
            });
            setOpen(false); setName(""); setUrl(""); setAuthKind("none"); setToken(""); setHeaders([{ name: "", value: "" }]);
          })}>Добавить</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleting !== null} onOpenChange={(value) => { if (!value) setDeleting(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Удалить сервер «{selected?.name}»?</AlertDialogTitle>
          <AlertDialogDescription>Агент больше не сможет им пользоваться. Сохранённые токен и заголовки будут удалены.</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void run(async () => { if (deleting) await state.remove(deleting); setDeleting(null); })}>Удалить</AlertDialogAction>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={signingOut !== null} onOpenChange={(value) => { if (!value && !busy) setSigningOut(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Сбросить вход?</AlertDialogTitle>
            <AlertDialogDescription>Агент попросит войти заново при следующем обращении к серверу.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void run(async () => {
              if (signingOut) await state.signout(signingOut);
              setSigningOut(null);
            })}>Сбросить вход</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldGroup>
  );
}
