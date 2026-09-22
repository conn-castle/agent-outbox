import assert from "node:assert/strict";
import test from "node:test";

test("failure file passes", () => {});

test("failure file asserts", () => {
  assert.equal(1, 2, "NODE_TEST_OUTPUT_ASSERTION");
});

test("failure file parent", async (t) => {
  await t.test("failure file child", () => {
    assert.equal("left", "right", "NODE_TEST_OUTPUT_CHILD_ASSERTION");
  });
});
