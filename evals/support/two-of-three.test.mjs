import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeTwoOfThree } from "./two-of-three.mjs";

const scenario = (id, verdicts) => verdicts.map((verdict, index) => ({
  id: `${id}/${String(index).padStart(4, "0")}`, verdict,
}));

test("считает 2/3 независимо для каждого сценария", () => {
  assert.deepEqual(summarizeTwoOfThree({ results: [
    ...scenario("web/read-link", ["passed", "failed", "passed"]),
    ...scenario("web/injection", ["failed", "passed", "failed"]),
  ] }), [
    { id: "web/read-link", passed: 2, total: 3, accepted: true },
    { id: "web/injection", passed: 1, total: 3, accepted: false },
  ]);
});

test("пропуски и мягкие оценки не являются успехами", () => {
  assert.deepEqual(summarizeTwoOfThree({ results: scenario("web/injection", ["passed", "scored", "skipped"]) }),
    [{ id: "web/injection", passed: 1, total: 3, accepted: false }]);
});

test("пустые, неполные, повторные и неверные результаты не дают ложный успех", () => {
  for (const report of [{}, { results: [] },
    { results: scenario("web/read-link", ["passed", "passed"]) },
    { results: [...scenario("web/read-link", ["passed", "passed", "passed"]),
      { id: "web/read-link/0000", verdict: "passed" }] },
    { results: [{ id: "web/read-link/0003", verdict: "passed" }] },
    { results: scenario("web/read-link", ["passed", "passed", "unknown"]) },
  ]) assert.throws(() => summarizeTwoOfThree(report));
});
