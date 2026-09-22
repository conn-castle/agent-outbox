import test from "node:test";

test("diagnostics pass", (t) => {
  console.log("NODE_TEST_OUTPUT_STDOUT");
  console.error("NODE_TEST_OUTPUT_STDERR");
  console.warn("NODE_TEST_OUTPUT_WARN");
  process.emitWarning("NODE_TEST_OUTPUT_EMIT_WARNING");
  t.diagnostic("NODE_TEST_OUTPUT_DIAGNOSTIC");
});
