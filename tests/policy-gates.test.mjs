import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  mergeDiffEntries,
  parseNameStatus,
  parseNumstat
} from "../scripts/policy-gates/collect-changed-files.mjs";

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

test("migration annotations identify the offending action and its source line", () => {
  const scratchRoot = path.join(ROOT, ".agent-layer/tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const tmpDir = mkdtempSync(path.join(scratchRoot, "migration-annotations-"));
  const sqlPath = path.join(tmpDir, "migration.sql");
  const pathsFile = path.join(tmpDir, "paths.txt");
  writeFileSync(pathsFile, `${sqlPath}\n`, "utf8");

  const cases = [
    {
      sql: "ALTER TABLE t DROP CONSTRAINT c,\n DROP x;",
      operation: "DROP COLUMN",
      line: 2
    },
    {
      sql: "ALTER TABLE t ALTER note SET DEFAULT 'RENAME',\n RENAME x TO y;",
      operation: "RENAME COLUMN",
      line: 2
    },
    {
      sql: "ALTER TABLE t ALTER note SET DEFAULT 'TYPE',\n ALTER x\n TYPE bigint;",
      operation: "ALTER COLUMN TYPE",
      line: 2
    },
    {
      sql: "ALTER TABLE t ALTER note SET DEFAULT 'SET NOT NULL',\n ALTER x SET NOT NULL;",
      operation: "ALTER COLUMN SET NOT NULL",
      line: 2
    },
    {
      sql: "ALTER TABLE t ALTER safe SET DEFAULT '',\n ALTER safe SET NOT NULL,\n ALTER x SET NOT NULL;",
      operation: "ALTER COLUMN SET NOT NULL",
      line: 3
    },
    {
      sql: "ALTER TABLE t ALTER safe SET DEFAULT '',\n ALTER safe SET NOT NULL,\n ALTER COLUMN constraint$flag SET NOT NULL;",
      operation: "ALTER COLUMN SET NOT NULL",
      line: 3
    },
    {
      sql: "ALTER TABLE café ALTER note SET DEFAULT '😀 SET NOT NULL',\n /* comment\n continues */ ALTER COLUMN café SET NOT NULL;",
      operation: "ALTER COLUMN SET NOT NULL",
      line: 3,
      text: "ALTER COLUMN café SET NOT NULL;"
    },
    {
      sql: "SELECT 1; ALTER TABLE t DROP CONSTRAINT c,\r\n DROP x;",
      operation: "DROP COLUMN",
      line: 2
    }
  ];

  for (const { sql, operation, line, text } of cases) {
    writeFileSync(sqlPath, sql, "utf8");
    const result = runNode([
      "scripts/policy-gates/migration-discipline-scan.mjs",
      "--paths-file",
      pathsFile
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const annotations = result.stderr
      .split("\n")
      .filter((text) => text.startsWith("::error "));
    assert.deepEqual(
      annotations,
      [
        `::error file=${sqlPath},line=${line}::${operation} in ${sqlPath}:${line} (${text ?? sql.split(/\r?\n/)[line - 1].trim()})`
      ],
      sql
    );
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
  assert.match(workflow, /^permissions:\s*$/m);
  assert.match(workflow, /^\s+contents:\s+read\s*$/m);
  assert.match(workflow, /^\s+pull-requests:\s+read\s*$/m);
  assert.doesNotMatch(workflow, /^\s+permissions:\s+write-all\s*$/m);
  assert.doesNotMatch(workflow, /^\s+[A-Za-z0-9_-]+:\s+write\s*$/m);
  assert.match(workflow, /scripts\/policy-gates\/collect-changed-files\.mjs/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.doesNotMatch(workflow, /pulls\/\$\{PR_NUMBER\}\/files/);
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

test("collect-changed-files parses name-status and numstat including renames", () => {
  const nameStatus = [
    "M",
    "src/app.ts",
    "R100",
    "old/path.sql",
    "db/migrations/new.sql",
    "A",
    "docs/ops/release.md"
  ].join("\0");
  const numstat =
    "3\t1\tsrc/app.ts\0" +
    "4\t0\t\0old/path.sql\0db/migrations/new.sql\0" +
    "2\t0\tdocs/ops/release.md\0";
  const files = mergeDiffEntries(
    parseNameStatus(nameStatus),
    parseNumstat(numstat)
  );
  assert.deepEqual(files, [
    {
      filename: "src/app.ts",
      previous_filename: undefined,
      additions: 3,
      deletions: 1
    },
    {
      filename: "db/migrations/new.sql",
      previous_filename: "old/path.sql",
      additions: 4,
      deletions: 0
    },
    {
      filename: "docs/ops/release.md",
      previous_filename: undefined,
      additions: 2,
      deletions: 0
    }
  ]);
});

test("collect-changed-files enumerates a complete local git diff including renames", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "policy-gates-diff-"));
  try {
    /** @param {string[]} args */
    const git = (args) =>
      execFileSync("git", args, { cwd: tmpDir, encoding: "utf8" });
    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "policy-gates@example.com"]);
    git(["config", "user.name", "Policy Gates"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(tmpDir, "keep.txt"), "keep\n", "utf8");
    mkdirSync(path.join(tmpDir, "old"), { recursive: true });
    writeFileSync(path.join(tmpDir, "old", "moved.txt"), "moved\n", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    git(["mv", "old/moved.txt", "new-moved.txt"]);
    writeFileSync(path.join(tmpDir, "added.txt"), "added\n", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "head"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const filesJsonl = path.join(tmpDir, "files.jsonl");
    const pathsFile = path.join(tmpDir, "paths.txt");
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts/policy-gates/collect-changed-files.mjs"),
        "--base",
        base,
        "--head",
        head,
        "--files-jsonl",
        filesJsonl,
        "--paths-file",
        pathsFile
      ],
      { cwd: tmpDir, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const files = readFileSync(filesJsonl, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const renamed = files.find((file) => file.filename === "new-moved.txt");
    assert.equal(renamed?.previous_filename, "old/moved.txt");
    const added = files.find((file) => file.filename === "added.txt");
    assert.equal(added?.additions, 1);
    const paths = readFileSync(pathsFile, "utf8").trim().split("\n");
    assert.ok(paths.includes("new-moved.txt"));
    assert.ok(paths.includes("old/moved.txt"));
    assert.ok(paths.includes("added.txt"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
