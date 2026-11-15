import { defineMemoryProvider, type MemoryOperationContext } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { recallMemory, removeMemory, saveMemory } from "@/lib/memory/store";
import { MEMORY_MESSAGE_PREFIX } from "@/lib/memory/text";

export function memoryUserId(value: string | readonly string[]): string {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== "user" ||
      !z.uuid().safeParse(value[1]).success) {
    throw new Error("Неверная область памяти пользователя.");
  }
  return value[1];
}

async function recall(ctx: MemoryOperationContext) {
  // eve не удаляет прежний id при null: пустая память должна заместить опубликованный блок.
  const replaceEmpty = ctx.messages.some((message) =>
    message.role === "user" && (
      typeof message.content === "string"
        ? message.content.startsWith(MEMORY_MESSAGE_PREFIX)
        : message.content.some((part) =>
          part.type === "text" && part.text.startsWith(MEMORY_MESSAGE_PREFIX))
    ));
  const content = await recallMemory(
    memoryUserId(ctx.memory.scope.value), ctx.operationId, replaceEmpty,
  );
  return content === null ? null : { messages: [{ id: "memory", content }] };
}

export function userMemoryProvider() {
  return defineMemoryProvider({
    recall: {
      "turn.started": recall,
      "compaction.completed": recall,
    },
    async tools(ctx) {
      const userId = memoryUserId(ctx.memory.scope.value);
      return {
        save: defineTool({
          description: "Запомнить устойчивое предпочтение пользователя о роликах. При limit удали ненужную запись из oldest и повтори сохранение.",
          label: { start: () => "Запоминаю предпочтение" },
          inputSchema: z.object({ text: z.string() }),
          execute: ({ text }) => saveMemory(userId, text),
        }),
        remove: defineTool({
          description: "Удалить ненужную запись долговременной памяти по её номеру.",
          label: { start: () => "Удаляю предпочтение" },
          inputSchema: z.object({ id: z.number().int() }),
          execute: ({ id }) => removeMemory(userId, id),
        }),
      };
    },
  });
}
