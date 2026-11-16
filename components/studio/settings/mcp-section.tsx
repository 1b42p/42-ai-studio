"use client";

import { useState } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { useMcpContext, type McpCheck, type McpState } from "./mcp-context";

const AUTH_LABELS = { none: "Без авторизации", bearer: "Токен", headers: "Заголовки", oauth: "OAuth" } as const;

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
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authKind, setAuthKind] = useState<"none" | "bearer" | "headers">("none");
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
      {state.servers.length === 0 ? <p className="text-sm text-muted-foreground">Серверов пока нет</p> : state.servers.map((server) => (
        <div className="flex min-w-0 flex-col gap-2" key={server.id}>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{server.name}</p>
              <p className="truncate text-sm text-muted-foreground">{server.url}</p>
              <Badge variant="secondary">{AUTH_LABELS[server.authKind]}</Badge>
            </div>
            <Switch aria-label={`Включён: ${server.name}`} checked={server.enabled} onCheckedChange={(enabled) => void run(() => state.toggle(server.id, enabled))} />
            <Button size="icon" variant="ghost" aria-label={`Проверить ${server.name}`} onClick={() => void state.check(server.id)}><RefreshCwIcon /></Button>
            <Button size="icon" variant="ghost" aria-label={`Удалить ${server.name}`} onClick={() => setDeleting(server.id)}><Trash2Icon /></Button>
          </div>
          {state.checks[server.id] && <p className="text-sm">{checkMessage(state.checks[server.id]!)}</p>}
        </div>
      ))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Добавить MCP-сервер</DialogTitle><DialogDescription>Укажите адрес и способ авторизации.</DialogDescription></DialogHeader>
          <FieldGroup>
            <Field data-invalid={error && errorField === "name" ? true : undefined}><FieldLabel htmlFor="mcp-name">Название</FieldLabel><Input id="mcp-name" aria-invalid={error && errorField === "name" ? true : undefined} value={name} onChange={(event) => setName(event.target.value)} />{errorField === "name" && <FieldError>{error}</FieldError>}</Field>
            <Field data-invalid={error && errorField === "url" ? true : undefined}><FieldLabel htmlFor="mcp-url">Адрес сервера</FieldLabel><Input id="mcp-url" aria-invalid={error && errorField === "url" ? true : undefined} placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />{errorField === "url" && <FieldError>{error}</FieldError>}</Field>
            <Field><FieldLabel htmlFor="mcp-auth">Авторизация</FieldLabel>
              <Select value={authKind} onValueChange={(value) => { if (value === "none" || value === "bearer" || value === "headers") setAuthKind(value); }}>
                <SelectTrigger id="mcp-auth"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="none">Без авторизации</SelectItem><SelectItem value="bearer">Токен (Bearer)</SelectItem><SelectItem value="headers">Свои заголовки</SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
            {authKind === "bearer" && <Field data-invalid={error && errorField === "token" ? true : undefined}><FieldLabel htmlFor="mcp-token">Токен</FieldLabel><Input id="mcp-token" aria-invalid={error && errorField === "token" ? true : undefined} type="password" value={token} onChange={(event) => setToken(event.target.value)} />{errorField === "token" && <FieldError>{error}</FieldError>}</Field>}
            {authKind === "headers" && <>
              {headers.map((header, index) => <div className="flex min-w-0 gap-2" key={index}>
                <Input aria-label={`Имя заголовка ${index + 1}`} placeholder="Имя" value={header.name} onChange={(event) => setHeaders((current) => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />
                <Input aria-label={`Значение заголовка ${index + 1}`} placeholder="Значение" type="password" value={header.value} onChange={(event) => setHeaders((current) => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
                <Button size="icon" variant="ghost" aria-label={`Убрать заголовок ${index + 1}`} onClick={() => setHeaders((current) => current.filter((_, i) => i !== index))}><Trash2Icon /></Button>
              </div>)}
              <Button variant="outline" onClick={() => setHeaders((current) => [...current, { name: "", value: "" }])} disabled={headers.length >= 10}>Добавить заголовок</Button>
              {errorField === "headers" && <FieldError>{error}</FieldError>}
            </>}
            {error && errorField === "general" && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          </FieldGroup>
          <DialogFooter><Button disabled={busy} onClick={() => void run(async () => {
            await state.add({ name, url, authKind, token, headers });
            setOpen(false); setName(""); setUrl(""); setToken(""); setHeaders([{ name: "", value: "" }]);
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
    </FieldGroup>
  );
}
