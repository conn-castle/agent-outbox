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
  // `release` defaults to runtimeRelease(), which reads SENTRY_RELEASE /
  // GITHUB_SHA. Clear both so the default resolves to "no release" (local dev)
  // rather than the ambient GITHUB_SHA that CI always sets — otherwise this
  // assertion would depend on the environment it runs in.
  const priorSentry = process.env.SENTRY_RELEASE;
  const priorGithub = process.env.GITHUB_SHA;
  delete process.env.SENTRY_RELEASE;
  delete process.env.GITHUB_SHA;
  try {
    assert.equal(formatVersionLabel("0.0.0"), "v0.0.0");
    assert.equal(formatVersionLabel("0.0.0", ""), "v0.0.0");
  } finally {
    if (priorSentry === undefined) delete process.env.SENTRY_RELEASE;
    else process.env.SENTRY_RELEASE = priorSentry;
    if (priorGithub === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = priorGithub;
  }
});

test("version label shows a non-SHA release identifier verbatim", () => {
  assert.equal(
    formatVersionLabel("1.2.3", "agent-outbox@2026.07.07"),
    "v1.2.3 · agent-outbox@2026.07.07"
  );
});
