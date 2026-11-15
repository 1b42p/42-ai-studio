import { expect, test } from "vitest";

import { readPreviewStream } from "../../../lib/session-preview/read";

test("поток ровно 1 МиБ сохраняет все байты", async () => {
  const bytes = new Uint8Array(1_048_576).fill(37);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const next = Math.min(offset + 65536, bytes.length);
      controller.enqueue(bytes.slice(offset, next));
      offset = next;
    },
  }, { highWaterMark: 0 });

  expect(await readPreviewStream(stream, "out/p.jpg")).toEqual(bytes);
  expect(stream.locked).toBe(false);
});

test("растущий поток отменяется на первом байте сверх предела, до чтения хвоста", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(new Uint8Array(1_048_576));
      else if (pulls === 2) controller.enqueue(new Uint8Array([1]));
      else throw new Error("Хвост файла не должен читаться");
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });

  await expect(readPreviewStream(stream, "out/p.jpg")).rejects.toThrow("preview_too_large");
  expect(pulls).toBe(2);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

test("крупный блок сверх предела отменяется без накопления следующих блоков", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(2 * 1_048_576)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });

  await expect(readPreviewStream(stream, "out/p.jpg")).rejects.toThrow("preview_too_large");
  expect(cancelled).toBe(true);
});
