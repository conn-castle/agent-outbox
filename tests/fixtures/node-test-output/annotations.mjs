import assert from "node:assert/strict";
import test from "node:test";

test("skipped case", { skip: "SKIP_REASON" }, () => {});

test("todo that fails", { todo: "TODO_REASON" }, () => {
  assert.equal(1, 2);
});
