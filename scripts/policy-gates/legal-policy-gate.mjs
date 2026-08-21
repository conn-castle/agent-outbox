#!/usr/bin/env node
/**
 * Public legal-policy approval gate.
 *
 * Fails when a PR touches the published Privacy Policy, Terms of Service, or
 * the shared legal identity used on those pages unless the human-only
 * `legal-policy-approved` label is applied. Any changed guarded path requires
 * approval; this is an intentional-review signal, not a size threshold.
 *
 * Input modes:
 *   Real diff:  --paths-file PATH       (newline-separated changed paths)
 *   Fixtures:   --fixtures PATH         (JSONL self-validation rows)
 *
 * Override:
 *   --label-present                     (legal-policy-approved is on)
 *
 * Exit codes:
 *   0 — no guarded paths changed, or label present
 *   1 — guarded paths changed and label absent
 *  64 — usage error
 */
import {
  dispatchPolicyGate,
  parseFixtureRows,
  readChangedFiles
} from "./gate-cli-utils.mjs";

const GUARDED_PATHS = [
  "app/privacy-policy/page.tsx",
  "app/terms-of-service/page.tsx",
  "src/components/legal/LegalDocument.tsx"
];

/**
 * @param {string[]} changedPaths
 * @returns {string[]}
 */
function guardedHits(changedPaths) {
  const guarded = new Set(GUARDED_PATHS);
  return changedPaths.filter((changedPath) => guarded.has(changedPath));
}

/**
 * @param {string} pathsFile
 * @param {boolean} labelPresent
 * @returns {number}
 */
function runPathsMode(pathsFile, labelPresent) {
  const hits = guardedHits(readChangedFiles(pathsFile));

  if (hits.length === 0) {
    console.log("OK: no public legal-policy files changed.");
    return 0;
  }

  console.log(`Public legal-policy files changed (${hits.length}):`);
  for (const hit of hits) console.log(`- ${hit}`);

  if (labelPresent) {
    console.log(
      "legal-policy-approved label is present; public legal-policy changes are approved."
    );
    return 0;
  }

  for (const hit of hits) {
    console.error(
      `::error file=${hit}::Change to a public legal-policy surface requires the legal-policy-approved label.`
    );
  }
  console.error(
    "Privacy Policy and Terms of Service changes require the legal-policy-approved label."
  );
  return 1;
}

/**
 * @param {string} fixturesPath
 * @returns {number}
 */
function runFixturesMode(fixturesPath) {
  const rows = parseFixtureRows(fixturesPath);
  let failures = 0;

  for (const row of rows) {
    const paths = Array.isArray(row.paths) ? row.paths.map(String) : [];
    const labelPresent = Boolean(row.label_present);
    const expected = String(row.expected ?? "");
    const hits = guardedHits(paths);
    const actual = hits.length === 0 || labelPresent ? "pass" : "fail";
    if (actual !== expected) {
      failures += 1;
      console.error(
        `FIXTURE MISMATCH: ${row.name ?? "<unnamed>"} expected=${expected} actual=${actual}`
      );
      console.error(
        `  hits=${hits.join(",") || "<none>"} label_present=${labelPresent}`
      );
    }
  }

  if (failures > 0) {
    console.error(
      `${failures}/${rows.length} legal-policy gate fixture(s) failed.`
    );
    return 1;
  }
  console.log(`All ${rows.length} legal-policy gate fixture(s) passed.`);
  return 0;
}

dispatchPolicyGate({
  scriptName: "legal-policy-gate.mjs",
  runPathsMode,
  runFixturesMode
});
