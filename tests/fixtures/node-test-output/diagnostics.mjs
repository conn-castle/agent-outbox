import assert from "node:assert/strict";
import test from "node:test";

test("DIAGNOSTICS_PASS_NAME", (t) => {
  console.log("NODE_TEST_OUTPUT_STDOUT");
  console.error("NODE_TEST_OUTPUT_STDERR");
  console.warn("NODE_TEST_OUTPUT_WARN");
  process.stderr.write("NODE_TEST_OUTPUT_RAW_STDERR\n");
  process.emitWarning("NODE_TEST_OUTPUT_EMIT_WARNING");
  t.diagnostic("NODE_TEST_OUTPUT_DIAGNOSTIC");
  console.log("::warning::keep-me");
  console.log('{"level":"warn","message":"keep-json"}');
});

test("skipped case", { skip: "SKIP_REASON" }, () => {});

test("todo that fails", { todo: "TODO_REASON" }, () => {
  assert.equal(1, 2);
});
