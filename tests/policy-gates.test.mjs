import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8"
  });
}

test("megachange fixture runner and threshold self-checks pass", () => {
  const result = runNode([
    "scripts/policy-gates/megachange-eval.test.mjs",
    "--fixtures",
    "scripts/policy-gates/megachange-cap-fixtures.txt"
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /All \d+ megachange fixtures passed/);
});

test("legal-policy fixtures pass and block unapproved public legal edits", () => {
  const fixtures = runNode([
    "scripts/policy-gates/legal-policy-gate.mjs",
    "--fixtures",
    "scripts/policy-gates/legal-policy-fixtures.txt"
  ]);
  assert.equal(fixtures.status, 0, fixtures.stderr || fixtures.stdout);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "legal-policy-"));
  try {
    const pathsFile = path.join(tmpDir, "paths.txt");
    writeFileSync(pathsFile, "app/privacy-policy/page.tsx\n", "utf8");
    const blocked = runNode([
      "scripts/policy-gates/legal-policy-gate.mjs",
      "--paths-file",
      pathsFile
    ]);
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    const approved = runNode([
      "scripts/policy-gates/legal-policy-gate.mjs",
      "--paths-file",
      pathsFile,
      "--label-present"
    ]);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("migration discipline fixtures pass and block unapproved DROP COLUMN", () => {
  const fixtures = runNode([
    "scripts/policy-gates/migration-discipline-scan.mjs",
    "--fixtures",
    "scripts/policy-gates/migration-discipline-fixtures.txt"
  ]);
  assert.equal(fixtures.status, 0, fixtures.stderr || fixtures.stdout);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "migration-discipline-"));
  try {
    const sqlPath = path.join(tmpDir, "V20260820120000__drop_legacy.sql");
    const pathsFile = path.join(tmpDir, "paths.txt");
    writeFileSync(
      sqlPath,
      'ALTER TABLE "users" DROP COLUMN "legacy_id";\n',
      "utf8"
    );
    writeFileSync(pathsFile, `${sqlPath}\n`, "utf8");
    const blocked = runNode([
      "scripts/policy-gates/migration-discipline-scan.mjs",
      "--paths-file",
      pathsFile
    ]);
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    const approved = runNode([
      "scripts/policy-gates/migration-discipline-scan.mjs",
      "--paths-file",
      pathsFile,
      "--label-present"
    ]);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("policy-gates workflow retriggers on labels and never applies them", () => {
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/policy-gates.yml"),
    "utf8"
  );
  assert.match(workflow, /^name: Policy gates$/m);
  assert.match(
    workflow,
    /^\s+types: \[opened, synchronize, reopened, labeled, unlabeled\]$/m
  );
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /scripts\/policy-gates\/megachange-eval\.mjs/);
  assert.match(
    workflow,
    /scripts\/policy-gates\/migration-discipline-scan\.mjs/
  );
  assert.match(workflow, /scripts\/policy-gates\/legal-policy-gate\.mjs/);
  assert.doesNotMatch(
    workflow,
    /--add-label\s+(megachange-approved|migration-destructive-approved|legal-policy-approved)/
  );
  assert.doesNotMatch(
    workflow,
    /gh\s+pr\s+edit.*(?:megachange-approved|migration-destructive-approved|legal-policy-approved)/
  );
});
