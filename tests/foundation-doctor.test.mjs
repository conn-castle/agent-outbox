import assert from "node:assert/strict";
import test from "node:test";

import {
  firstVersionToken,
  goVersionFromOutput,
  providerAuthResult,
  semanticVersionFromOutput,
  supabaseProjectsIncludeRef,
  versionResult
} from "../scripts/foundation/doctor.mjs";

test("supabaseProjectsIncludeRef checks project refs without exposing project output", () => {
  const projectsJson = JSON.stringify([
    { id: "not-agent-outbox", name: "Other" },
    { id: "agent-outbox-ref", name: "Agent Outbox" }
  ]);

  assert.equal(
    supabaseProjectsIncludeRef(projectsJson, "agent-outbox-ref"),
    true
  );
  assert.equal(supabaseProjectsIncludeRef(projectsJson, "missing-ref"), false);
});

test("doctor version parsers extract pinned tool versions", () => {
  assert.equal(firstVersionToken("v24.18.0\n"), "v24.18.0");
  assert.equal(firstVersionToken("11.9.0 extra output"), "11.9.0");
  assert.equal(
    goVersionFromOutput("go version go1.26.4 linux/amd64"),
    "go1.26.4"
  );
  assert.equal(
    semanticVersionFromOutput("wrangler 4.126.0 (update available)"),
    "4.126.0"
  );
  assert.equal(goVersionFromOutput("unparseable"), "");
  assert.equal(semanticVersionFromOutput("unparseable"), "");
});

test("doctor command checks report missing commands and failed exits", () => {
  const missing = "agent-outbox-command-that-does-not-exist";
  const failingArgs = ["-e", "process.exit(3)"];
  const redacted = '{"status":3,"signal":null,"error":null}';

  assert.deepEqual(versionResult(missing, ["--version"], "1.0.0", String), {
    ok: false,
    message: `${missing} is not installed`
  });
  assert.deepEqual(providerAuthResult(missing, []), {
    ok: false,
    message: `${missing} is not installed`
  });
  assert.deepEqual(versionResult("node", failingArgs, "1.0.0", String), {
    ok: false,
    message: `node version check failed (${redacted})`
  });
  assert.deepEqual(providerAuthResult("node", failingArgs), {
    ok: false,
    message: `node auth check failed (${redacted})`
  });
  assert.deepEqual(providerAuthResult("node", ["-e", ""]), {
    ok: true,
    message: "node auth check passed"
  });
});
