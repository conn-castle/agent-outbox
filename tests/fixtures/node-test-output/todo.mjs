import assert from "node:assert/strict";
import test from "node:test";

test("todo failure is not a failure", { todo: "not done" }, () => {
  assert.equal(1, 2, "NODE_TEST_OUTPUT_TODO");
});
