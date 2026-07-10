import assert from "node:assert/strict";
import test from "node:test";

import { formatVersionLabel } from "../src/server/app-version.ts";

test("version label shortens a deployed git SHA to seven characters", () => {
  assert.equal(
    formatVersionLabel("0.1.0", "0123456789abcdef0123456789abcdef01234567"),
    "v0.1.0 · 0123456"
  );
});

test("version label omits the build id when no release is deployed", () => {
  assert.equal(formatVersionLabel("0.0.0", undefined), "v0.0.0");
  assert.equal(formatVersionLabel("0.0.0", ""), "v0.0.0");
});

test("version label shows a non-SHA release identifier verbatim", () => {
  assert.equal(
    formatVersionLabel("1.2.3", "agent-outbox@2026.07.07"),
    "v1.2.3 · agent-outbox@2026.07.07"
  );
});
