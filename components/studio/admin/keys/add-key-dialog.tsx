"use client";

import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export interface AddKeyDialogProps {
  readonly open: boolean;
  readonly label: string;
  readonly apiKey: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLabelChange: (value: string) => void;
  readonly onApiKeyChange: (value: string) => void;
  readonly onSubmit: () => void;
}

/** Диалог добавления: поле секрета парольное, после успеха родитель стирает значение. */
export function AddKeyDialog({
  open,
  label,
  apiKey,
  pending,
  error,
  onOpenChange,
  onLabelChange,
  onApiKeyChange,
  onSubmit,
}: AddKeyDialogProps) {
  const empty = label.trim().length === 0 || apiKey.trim().length === 0;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="max-w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>Добавить ключ</DialogTitle>
          <DialogDescription>
            Ключ шифруется и больше нигде не показывается.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="daytona-key-label">Название</FieldLabel>
          <Input
            autoComplete="off"
            id="daytona-key-label"
            onChange={(event) => onLabelChange(event.target.value)}
            value={label}
          />
        </Field>
        <Field data-invalid={error !== null ? "" : undefined}>
          <FieldLabel htmlFor="daytona-api-key">API-ключ Daytona</FieldLabel>
          <Input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            id="daytona-api-key"
            onChange={(event) => onApiKeyChange(event.target.value)}
            spellCheck={false}
            type="password"
            value={apiKey}
          />
          <FieldDescription>
            Ключ создаётся в панели Daytona (Dashboard → API Keys). Нужные права: перечень из README. Ключ шифруется и больше нигде не показывается.
          </FieldDescription>
          {error !== null ? <FieldError>{error}</FieldError> : null}
        </Field>
        <DialogFooter>
          <Button disabled={empty || pending} onClick={onSubmit}>
            {pending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
