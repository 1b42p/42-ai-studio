/** Инструмент edit_file на фиктивной песочнице. */
import { beforeEach, describe, expect, test } from "vitest";
import type { MessageStreamEvent } from "eve/client";

import { editFileErrorMessage } from "../../lib/edit-file/errors";
import { createSessionAs, eveClientAs, sendAndWait, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
  await createDaytonaKey();
});

function toolResult(events: readonly MessageStreamEvent[], name = "edit_file") {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find(
    (item) => item.data.result.kind === "tool-result" && item.data.result.toolName === name,
  );
  expect(event, `Нет результата ${name}`).toBeDefined();
  return event!.data;
}

function toolCommand(input: Record<string, unknown>): string {
  return `/tool edit_file ${JSON.stringify(input)}`;
}

describe("edit_file", () => {
  test("замена единственного фрагмента меняет файл и возвращает diff-поля", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "one\ntwo\nthree\n" });

    const events = await sendAndWait(
      user,
      id,
      toolCommand({
        filePath: "/workspace/notes.txt",
        oldString: "two",
        newString: "zwei",
      }),
    );
    const result = toolResult(events);
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({
      kind: "tool-result",
      toolName: "edit_file",
      output: {
        path: "/workspace/notes.txt",
        created: false,
        replacements: 1,
        oldContent: "one\ntwo\nthree\n",
        newContent: "one\nzwei\nthree\n",
        linesAdded: 1,
        linesRemoved: 1,
      },
    });
    expect(new Uint8Array((await fakeSandbox.files.read(id, "/workspace/notes.txt"))!)).toEqual(
      new TextEncoder().encode("one\nzwei\nthree\n"),
    );
  });

  test("replaceAll заменяет все вхождения", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/a.txt": "x x x" });

    const result = toolResult(
      await sendAndWait(
        user,
        id,
        toolCommand({
          filePath: "/workspace/a.txt",
          oldString: "x",
          newString: "y",
          replaceAll: true,
        }),
      ),
    );
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({
      output: { replacements: 3, newContent: "y y y" },
    });
  });

  test("создание файла в несуществующем каталоге", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);

    const result = toolResult(
      await sendAndWait(
        user,
        id,
        toolCommand({
          filePath: "/workspace/nested/dir/hello.txt",
          newString: "привет\n",
        }),
      ),
    );
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({
      output: {
        created: true,
        oldContent: null,
        newContent: "привет\n",
        path: "/workspace/nested/dir/hello.txt",
      },
    });
    expect(new Uint8Array((await fakeSandbox.files.read(id, "/workspace/nested/dir/hello.txt"))!)).toEqual(
      new TextEncoder().encode("привет\n"),
    );
  });

  test("overwrite: true возвращает прежнее содержимое", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/a.txt": "было\n" });

    const result = toolResult(
      await sendAndWait(
        user,
        id,
        toolCommand({
          filePath: "/workspace/a.txt",
          newString: "стало\n",
          overwrite: true,
        }),
      ),
    );
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({
      output: { created: false, oldContent: "было\n", newContent: "стало\n" },
    });
  });

  test("полный выход остаётся в session_events после остановки песочницы", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/a.txt": "alpha\n" });

    await sendAndWait(
      user,
      id,
      toolCommand({ filePath: "/workspace/a.txt", oldString: "alpha", newString: "beta" }),
    );
    await fakeSandbox.stop(id);

    const stored = await waitForStoredEvents(user, id, (items) =>
      items.some(
        (item) =>
          item.payload.type === "action.result" &&
          item.payload.data.result.kind === "tool-result" &&
          item.payload.data.result.toolName === "edit_file",
      ),
    );
    const event = stored.find(
      (item) =>
        item.payload.type === "action.result" &&
        item.payload.data.result.kind === "tool-result" &&
        item.payload.data.result.toolName === "edit_file",
    );
    expect(event?.payload).toMatchObject({
      type: "action.result",
      data: {
        status: "completed",
        result: {
          output: {
            oldContent: "alpha\n",
            newContent: "beta\n",
            linesAdded: 1,
            linesRemoved: 1,
          },
        },
      },
    });
  });

  test.each<[
    "not_found" | "fragment_not_found" | "ambiguous" | "exists" | "no_change" | "bad_path",
    Record<string, string>,
    Record<string, unknown>,
    string,
    number,
    string | null,
  ]>([
    ["not_found", {}, { filePath: "/workspace/missing.txt", oldString: "x", newString: "y" }, "/workspace/missing.txt", 0, null],
    ["fragment_not_found", { "/workspace/a.txt": "hello\n" }, { filePath: "/workspace/a.txt", oldString: "nope", newString: "y" }, "/workspace/a.txt", 0, "/workspace/a.txt"],
    ["ambiguous", { "/workspace/a.txt": "aa" }, { filePath: "/workspace/a.txt", oldString: "a", newString: "b" }, "/workspace/a.txt", 2, "/workspace/a.txt"],
    ["exists", { "/workspace/a.txt": "data" }, { filePath: "/workspace/a.txt", newString: "other" }, "/workspace/a.txt", 0, "/workspace/a.txt"],
    ["no_change", { "/workspace/a.txt": "same" }, { filePath: "/workspace/a.txt", oldString: "same", newString: "same" }, "/workspace/a.txt", 0, "/workspace/a.txt"],
    ["bad_path", {}, { filePath: "$HOME/notes.txt", newString: "x" }, "", 0, null],
  ])("ошибка %s не меняет файл", async (name, seed, input, path, count, watch) => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    if (Object.keys(seed).length > 0) await fakeSandbox.seed(id, seed);
    const before = watch === null ? undefined : seed[watch];

    const result = toolResult(await sendAndWait(user, id, toolCommand(input)));
    expect(result.status).toBe("failed");
    const message = editFileErrorMessage(name, path, count);
    expect(result.error?.message ?? JSON.stringify(result)).toContain(message);

    if (watch !== null && before !== undefined) {
      expect(new Uint8Array((await fakeSandbox.files.read(id, watch))!)).toEqual(
        new TextEncoder().encode(before),
      );
    }
  });

  test("is_directory", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/folder/child.txt": "x\n" });

    const result = toolResult(
      await sendAndWait(
        user,
        id,
        toolCommand({ filePath: "/workspace/folder", newString: "y" }),
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(editFileErrorMessage("is_directory", "/workspace/folder"));
    expect(new Uint8Array((await fakeSandbox.files.read(id, "/workspace/folder/child.txt"))!)).toEqual(
      new TextEncoder().encode("x\n"),
    );
  });

  test("too_large", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const huge = "a".repeat(262_145);
    await fakeSandbox.seed(id, { "/workspace/big.txt": huge });

    const result = toolResult(
      await sendAndWait(
        user,
        id,
        toolCommand({
          filePath: "/workspace/big.txt",
          oldString: "a",
          newString: "b",
          replaceAll: true,
        }),
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(editFileErrorMessage("too_large", "/workspace/big.txt"));
    expect(new Uint8Array((await fakeSandbox.files.read(id, "/workspace/big.txt"))!)).toEqual(
      new TextEncoder().encode(huge),
    );
  });

  test("not_text", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/bin.dat": new Uint8Array([0xff, 0xfe, 0xfd]) });

    const result = toolResult(
      await sendAndWait(
        user,
        id,
        toolCommand({
          filePath: "/workspace/bin.dat",
          oldString: "x",
          newString: "y",
        }),
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe(editFileErrorMessage("not_text", "/workspace/bin.dat"));
  });
});

test("оператор видит edit_file и read_file, но не write_file; инструкции упоминают edit_file", async () => {
  const operator = await createUser({ isOperator: true });
  const { id } = await createSessionAs(operator);
  const client = await eveClientAs(operator, id);
  const info = await client.info();
  const names = info.tools.static.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(["bash", "read_file", "edit_file"]));
  expect(names).not.toContain("write_file");
  const instructionText = (info.instructions.static ?? [])
    .map((entry) => entry.content)
    .join("\n");
  expect(instructionText).toMatch(/edit_file/);
});
