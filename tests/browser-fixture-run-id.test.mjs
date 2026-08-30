import assert from "node:assert/strict";
import test from "node:test";

import { validateBrowserFixtureRunId } from "../scripts/browser-fixture-run-id.mjs";

test("browser fixture run ids are safe for shell and Docker interpolation", () => {
  assert.equal(validateBrowserFixtureRunId("run_2026-08.12"), "run_2026-08.12");
  for (const invalid of [
    "",
    "bad id",
    "$(touch-pwned)",
    "'quoted'",
    "semi;colon"
  ]) {
    assert.throws(
      () => validateBrowserFixtureRunId(invalid),
      /must contain only/
    );
  }
});
