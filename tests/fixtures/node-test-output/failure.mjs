import assert from "node:assert/strict";
import test from "node:test";

test("INTENTIONAL_FAIL_NAME", () => {
  assert.equal(1, 2);
});
