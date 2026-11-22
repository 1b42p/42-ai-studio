"use client";

import { AlertCircleIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

import type { SettingsSectionProps } from "./section";

export function MemorySection({ settings, save }: SettingsSectionProps) {
  const id = useId();
  const [optimisticValue, setOptimisticValue] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  const pending = optimisticValue !== null;

  async function changeMemory(enabled: boolean) {
    if (pending) return;
    setOptimisticValue(enabled);
    setError(false);
    try {
      await save({ memoryEnabled: enabled });
    } catch {
      setError(true);
    } finally {
      setOptimisticValue(null);
    }
  }

  return (
    <FieldGroup>
      <Field orientation="horizontal" data-disabled={pending}>
        <FieldContent className="min-w-0">
          <FieldLabel id={`${id}-label`} htmlFor={id}>Запоминать мои предпочтения</FieldLabel>
          <FieldDescription id={`${id}-description`}>
            Изменение действует со следующего запроса после завершения текущего ответа.
          </FieldDescription>
        </FieldContent>
        <Switch
          id={id}
          checked={optimisticValue ?? settings.memoryEnabled}
          disabled={pending}
          aria-busy={pending}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          onCheckedChange={(checked) => void changeMemory(checked)}
        />
      </Field>
      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>
            Не удалось изменить настройку памяти. Попробуйте ещё раз.
          </AlertDescription>
        </Alert>
      ) : null}
    </FieldGroup>
  );
}
