"use client";

import type { InputResponse } from "eve/client";
import type { ConversationInput } from "eve/react";
import { ArrowUpIcon, CircleHelpIcon, ShieldQuestionIcon } from "lucide-react";
import { useRef, useState } from "react";

import { isTouchInput } from "@/components/studio/chat/keyboard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle,
} from "@/components/ui/item";
import {
  Questionnaire, QuestionnaireAnswer, QuestionnaireChoiceDescription,
  QuestionnaireChoices, QuestionnaireItem, QuestionnaireTitle, QuestionnaireTextarea,
} from "@/components/ui/questionnaire";

export type RespondToInput = (responses: readonly InputResponse[]) => void | Promise<void>;

function optionsFor(request: ConversationInput["request"]) {
  return (request.options ?? []).map((option) => ({
    ...option,
    label: request.kind === "session-limit"
      ? option.id === "continue" ? "Продолжить" : "Остановить"
      : option.label,
  }));
}

/** Reads the ledger, not the tool part: a submitted response is not yet settled. */
export function InputPrompt({ input, disabled = false, onRespond }: {
  input: ConversationInput;
  disabled?: boolean;
  onRespond: RespondToInput;
}) {
  const { request, status, outcome, response } = input;
  const options = optionsFor(request);
  const prompt = request.kind === "session-limit"
    ? "Достигнут лимит расходов модели на сессию. Продолжить работу?"
    : request.prompt;
  const answer = response?.text ?? options.find((option) => option.id === response?.optionId)?.label;
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const locked = disabled || status !== "open" || pending;

  async function submit(value: InputResponse) {
    if (locked || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onRespond([value]);
    } catch {
      setError("Не удалось отправить ответ. Попробуйте ещё раз.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function submitText() {
    if (text.trim()) void submit({ requestId: request.requestId, text: text.trim() });
  }

  if (status === "settled") {
    return (
      <Item size="sm" variant="muted" className="min-w-0 wrap-anywhere" role="status">
        <ItemContent>
          <ItemDescription className="line-clamp-none whitespace-pre-wrap">
            {outcome === "answered"
              ? `${prompt} → ${answer ?? "Ответ получен"}`
              : outcome === "cancelled" || outcome === "ignored" ? "Вопрос снят" : "Вопрос закрыт"}
          </ItemDescription>
        </ItemContent>
      </Item>
    );
  }

  const feedback = status === "responded" ? (
    <Item size="sm" role="status">
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap wrap-anywhere">{answer}</ItemTitle>
        <ItemDescription>Ответ отправлен</ItemDescription>
      </ItemContent>
    </Item>
  ) : error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null;

  if (request.kind !== "question") {
    return (
      <Item size="sm" variant="outline" className="min-w-0 flex-wrap" aria-label={request.kind === "session-limit" ? "Лимит сессии" : "Подтверждение"}>
        <ItemMedia variant="icon"><ShieldQuestionIcon /></ItemMedia>
        <ItemContent>
          <ItemTitle className="wrap-anywhere">{request.kind === "session-limit" ? "Лимит сессии" : "Нужно подтверждение"}</ItemTitle>
          <ItemDescription className="line-clamp-none whitespace-pre-wrap wrap-anywhere">{prompt}</ItemDescription>
        </ItemContent>
        <ItemActions className="flex-wrap">
          {options.map((option) => (
            <Button key={option.id} size="sm" disabled={locked}
              variant={option.style === "danger" ? "destructive" : "outline"}
              onClick={() => void submit({ requestId: request.requestId, optionId: option.id })}>
              {option.label}
            </Button>
          ))}
        </ItemActions>
        {feedback}
      </Item>
    );
  }

  return (
    <Card size="sm" className="min-w-0" aria-label={input.taskId ? "Вопрос от копии агента" : "Вопрос от агента"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CircleHelpIcon />{input.taskId ? "Вопрос от копии агента" : "Вопрос от агента"}</CardTitle>
      </CardHeader>
      <CardContent>
        <Questionnaire onSubmit={(event) => { event.preventDefault(); submitText(); }}>
          <QuestionnaireItem name={request.requestId}>
            <QuestionnaireTitle className="whitespace-pre-wrap wrap-anywhere">{prompt}</QuestionnaireTitle>
            {options.length > 0 ? (
              <QuestionnaireChoices className="md:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
                {options.map((option) => (
                  <QuestionnaireAnswer key={option.id} disabled={locked}
                    onClick={() => void submit({ requestId: request.requestId, optionId: option.id })}>
                    <span>{option.label}</span>
                    {option.description ? <QuestionnaireChoiceDescription>{option.description}</QuestionnaireChoiceDescription> : null}
                  </QuestionnaireAnswer>
                ))}
              </QuestionnaireChoices>
            ) : null}
            {request.allowFreeform ? (
              <>
                <QuestionnaireTextarea aria-label="Свой ответ" disabled={locked}
                  placeholder={options.length ? "Или напишите свой ответ" : "Напишите свой ответ"}
                  value={text} onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    // The questionnaire's single-line Enter shortcut must not
                    // consume multiline or touch-keyboard line breaks.
                    if (event.key === "Enter") event.stopPropagation();
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !isTouchInput()) {
                      event.preventDefault();
                      submitText();
                    }
                  }} />
                <Button type="submit" size="sm" disabled={locked || !text.trim()} className="self-end">
                  <ArrowUpIcon data-icon="inline-start" />Ответить
                </Button>
              </>
            ) : null}
          </QuestionnaireItem>
          {feedback}
        </Questionnaire>
      </CardContent>
    </Card>
  );
}
