#!/usr/bin/env node
/**
 * Megachange-cap evaluator.
 *
 * Input modes:
 *   Real diff:  --files-jsonl <path>  (JSONL: one {filename,previous_filename?,additions,deletions} per line)
 *   Synthetic:  --synthetic --file-count N --line-total N
 *
 * Output (JSON, one line):
 *   { file_count, line_total, non_allowlisted_files, verdict, reason }
 *
 * Real-diff mode excludes allowlisted paths from file and line totals. Files
 * whose diff stats indicate a single changed line still count toward the file
 * cap, but are excluded from line totals. Single-line replacements count as
 * additions=1 and deletions=1 in GitHub PR file stats.
 *
 * Exit codes: 0 on successful evaluation (inspect `verdict` for pass/fail).
 *             Non-zero on usage errors or missing inputs.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import ignore from "ignore";

/**
 * @typedef {{
 *   filename?: unknown,
 *   previous_filename?: unknown,
 *   additions?: unknown,
 *   deletions?: unknown
 * }} MegachangeFileEntry
 */

const { values: args } = parseArgs({
  options: {
    allowlist: {
      type: "string",
      default: "scripts/policy-gates/megachange-allowlist.txt"
    },
    "max-files": { type: "string", default: "30" },
    "max-lines": { type: "string", default: "1000" },
    "label-present": { type: "boolean", default: false },
    synthetic: { type: "boolean", default: false },
    "file-count": { type: "string", default: "0" },
    "line-total": { type: "string", default: "0" },
    "files-jsonl": { type: "string" }
  }
});

const maxFiles = parseInt(args["max-files"], 10);
const maxLines = parseInt(args["max-lines"], 10);
const labelPresent = args["label-present"];

/**
 * Return true when diff stats heuristically indicate a tiny file change.
 *
 * GitHub reports both one-line replacements and independent one-line add plus
 * delete edits as additions=1/deletions=1, so this treats (1,1) as small
 * enough to exclude from the line-total cap without claiming exact source-line
 * reconstruction from PR file stats.
 */
/**
 * @param {number} additions
 * @param {number} deletions
 * @returns {boolean}
 */
function isSingleLineChange(additions, deletions) {
  return (
    (additions === 1 && deletions === 0) ||
    (additions === 0 && deletions === 1) ||
    (additions === 1 && deletions === 1)
  );
}

/**
 * Return the current or previous path that should count against the cap.
 *
 * Renamed PR files can move from non-allowlisted code into an allowlisted
 * path; checking both sides prevents that rename from hiding the file count.
 */
/**
 * @param {{ filename: string, previous_filename?: string }} entry
 * @param {{ ignores: (path: string) => boolean }} allowlist
 * @returns {string}
 */
function firstNonAllowlistedPath(entry, allowlist) {
  const paths = [entry.filename];
  if (
    typeof entry.previous_filename === "string" &&
    entry.previous_filename.length > 0 &&
    entry.previous_filename !== entry.filename
  ) {
    paths.push(entry.previous_filename);
  }
  return paths.find((path) => !allowlist.ignores(path)) ?? "";
}

/** @type {number} */
let fileCount = 0;
/** @type {number} */
let lineTotal = 0;
/** @type {string[]} */
let nonAllowlisted = [];

if (args.synthetic) {
  fileCount = parseInt(args["file-count"], 10);
  lineTotal = parseInt(args["line-total"], 10);
  nonAllowlisted = [];
} else {
  if (!args["files-jsonl"]) {
    process.stderr.write(
      "megachange-eval.mjs: --files-jsonl is required in non-synthetic mode\n"
    );
    process.exit(2);
  }

  const allowlistText = readFileSync(args.allowlist, "utf8");
  const ig = ignore().add(allowlistText.replace(/\r\n?/g, "\n"));

  const raw = readFileSync(args["files-jsonl"], "utf8");
  const files = raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => /** @type {MegachangeFileEntry} */ (JSON.parse(line)));

  nonAllowlisted = [];
  lineTotal = 0;

  for (const entry of files) {
    if (typeof entry?.filename !== "string" || entry.filename.length === 0) {
      process.stderr.write(
        `megachange-eval.mjs: skipping entry with missing filename: ${JSON.stringify(entry)}\n`
      );
      continue;
    }
    const nonAllowlistedPath = firstNonAllowlistedPath(
      {
        filename: entry.filename,
        previous_filename:
          typeof entry.previous_filename === "string"
            ? entry.previous_filename
            : undefined
      },
      ig
    );
    if (nonAllowlistedPath === "") continue;
    const additions = Number(entry.additions ?? 0);
    const deletions = Number(entry.deletions ?? 0);
    nonAllowlisted.push(nonAllowlistedPath);
    if (isSingleLineChange(additions, deletions)) continue;
    lineTotal += additions + deletions;
  }
  fileCount = nonAllowlisted.length;
}

let verdict;
let reason;
if (labelPresent) {
  verdict = "pass";
  reason = "megachange-approved label present";
} else if (fileCount > maxFiles) {
  verdict = "fail";
  reason = `file count ${fileCount} exceeds threshold ${maxFiles} (and no megachange-approved label)`;
} else if (lineTotal > maxLines) {
  verdict = "fail";
  reason = `line total ${lineTotal} exceeds threshold ${maxLines} (and no megachange-approved label)`;
} else {
  verdict = "pass";
  reason = "under thresholds";
}

process.stdout.write(
  JSON.stringify({
    file_count: fileCount,
    line_total: lineTotal,
    non_allowlisted_files: nonAllowlisted,
    verdict,
    reason
  }) + "\n"
);
