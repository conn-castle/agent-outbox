import assert from "node:assert/strict";
import test from "node:test";

import {
  firstVersionToken,
  goVersionFromOutput,
  semanticVersionFromOutput,
  supabaseProjectsIncludeRef
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
