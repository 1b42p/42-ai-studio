"use client";

import { AlertCircleIcon, SaveIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useTextDraft, useUnsavedChangesWarning } from "@/components/studio/use-text-draft";
import {
  CUSTOM_INSTRUCTIONS_LIMIT,
  customInstructionsLength,
  normalizeCustomInstructions,
} from "@/lib/settings/schema";

import type { SettingsSectionProps } from "./section";
import { SETTINGS_SAVE_ERROR, SettingsValidationError } from "./settings-error";
import { useSettingsAccount } from "./account-context";

export function InstructionsSection({ settings, save }: SettingsSectionProps) {
  const id = useId();
  const { user } = useSettingsAccount();
  const draft = useTextDraft(`studio:draft:v1:${user.id}:instructions`, settings.customInstructions);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft.value;
  const length = customInstructionsLength(value);
  const tooLong = length > CUSTOM_INSTRUCTIONS_LIMIT;
  const CountDescription = tooLong ? FieldError : FieldDescription;
  const unchanged = normalizeCustomInstructions(value) === settings.customInstructions;
  useUnsavedChangesWarning(!unchanged && !draft.persisted);

  async function submit() {
    if (pending || tooLong || unchanged) return;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const savedSettings = await save({ customInstructions: normalizeCustomInstructions(value) });
      draft.clear(savedSettings.customInstructions);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof SettingsValidationError ? cause.message : SETTINGS_SAVE_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <FieldGroup>
      <Field data-invalid={tooLong} data-disabled={pending}>
        <FieldLabel htmlFor={id} className="sr-only">Общие указания</FieldLabel>
        <Textarea
          id={id}
          value={value}
          disabled={pending}
          aria-invalid={tooLong}
          aria-describedby={`${id}-count`}
          placeholder="Опишите, как агенту работать с вами"
          className="min-h-48 min-w-0 resize-y [field-sizing:fixed]"
          onChange={(event) => {
            draft.setValue(event.target.value);
            setSaved(false);
            setError(null);
          }}
        />
        <CountDescription
          id={`${id}-count`}
          aria-live="polite"
        >
          {length} из {CUSTOM_INSTRUCTIONS_LIMIT}
        </CountDescription>
      </Field>
      {error !== null ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field>
        <Button
          type="button"
          aria-label="Сохранить"
          aria-busy={pending}
          className="w-full sm:w-fit"
          disabled={pending || unchanged || tooLong}
          onClick={() => void submit()}
        >
          {pending ? (
            <Spinner data-icon="inline-start" aria-label="Сохранение" />
          ) : (
            <SaveIcon data-icon="inline-start" />
          )}
          Сохранить
        </Button>
        <FieldDescription role="status">{saved ? "Сохранено" : null}</FieldDescription>
      </Field>
    </FieldGroup>
  );
}
