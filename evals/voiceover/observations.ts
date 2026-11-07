import type { EveEvalToolCall } from "eve/evals";

type Call = Pick<EveEvalToolCall, "name" | "status" | "input">;

/** Проверяет намерение синтезировать каждую сцену; stubs не исполняют shell. */
export function piperScenes(calls: readonly Call[]): number[] {
  const scenes = new Set<number>();
  const add = (path: string) => {
    const match = /(?:^|\/)scene-0?([123])-piper$/u.exec(path);
    if (match) scenes.add(Number(match[1]));
  };
  for (const call of calls) {
    if (call.name !== "bash" || call.status !== "completed" || typeof call.input.command !== "string") continue;
    const command = call.input.command;
    // Разделяем отдельные запуски, чтобы --out соседней команды не засчитался синтезу.
    let position = 0;
    for (const invocation of command.split(/(?=python3?\s)/u)) {
      const invocationAt = position;
      position += invocation.length;
      if (!/python3?\s+[^;\n]*piper_speak\.py\b/u.test(invocation) ||
          !/--text-file\b/u.test(invocation) || !/--voice\b/u.test(invocation)) continue;
      const output = /--out(?:=|\s+)("[^"]*"|'[^']*'|[^\s;]+)/u.exec(invocation)?.[1]?.replace(/^["']|["']$/gu, "");
      if (!output) continue;
      add(output);
      // Обычный пакетный запуск из навыка: for i in 01 02 03; do … scene-${i}-piper.
      for (const loop of command.matchAll(/\bfor\s+([a-zA-Z_]\w*)\s+in\s+([^;\n]+)[;\n]\s*do\b[\s\S]*?\bdone\b/gu)) {
        if (invocationAt < loop.index || invocationAt >= loop.index + loop[0].length) continue;
        const values = loop[2].trim();
        const numbers = /^\{0?1\.\.0?3\}$/u.test(values) || /^\$\(seq\s+(?:-w\s+)?1\s+3\)$/u.test(values)
          ? ["1", "2", "3"] : values.split(/\s+/u).filter((value) => /^0?[123]$/u.test(value));
        for (const value of numbers) {
          add(output.replaceAll(`\${${loop[1]}}`, value).replace(new RegExp(`\\$${loop[1]}(?!\\w)`, "gu"), value));
        }
      }
    }
  }
  return [...scenes].sort();
}
