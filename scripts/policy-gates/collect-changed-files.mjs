#!/usr/bin/env node
/**
 * Enumerate a complete base-to-head diff into the policy-gate JSONL and path
 * list. Fails closed when git output cannot be parsed or a path is missing
 * stats, instead of using the 3,000-file pull-request files API.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * @typedef {{ filename: string, previous_filename?: string }} NameStatusEntry
 * @typedef {{
 *   filename: string,
 *   previous_filename?: string,
 *   additions: number,
 *   deletions: number
 * }} ChangedFile
 */

/**
 * @param {string} output
 * @returns {NameStatusEntry[]}
 */
export function parseNameStatus(output) {
  const parts = output.split("\0");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  /** @type {NameStatusEntry[]} */
  const entries = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i] ?? "";
    const code = status.charAt(0);
    if (code === "") {
      throw new Error("incomplete git name-status output");
    }
    if (code === "R" || code === "C") {
      const previous_filename = parts[i + 1];
      const filename = parts[i + 2];
      if (!previous_filename || !filename) {
        throw new Error("incomplete git rename/copy name-status output");
      }
      entries.push({ filename, previous_filename });
      i += 3;
      continue;
    }
    const filename = parts[i + 1];
    if (!filename) {
      throw new Error("incomplete git name-status output");
    }
    entries.push({ filename });
    i += 2;
  }
  return entries;
}

/**
 * @param {string} output
 * @returns {Map<string, { additions: number, deletions: number }>}
 */
export function parseNumstat(output) {
  /** @type {Map<string, { additions: number, deletions: number }>} */
  const stats = new Map();
  let rest = output;
  while (rest.length > 0) {
    const firstTab = rest.indexOf("\t");
    const secondTab = rest.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error("incomplete git numstat output");
    }
    const addedRaw = rest.slice(0, firstTab);
    const deletedRaw = rest.slice(firstTab + 1, secondTab);
    const additions = addedRaw === "-" ? 0 : Number(addedRaw);
    const deletions = deletedRaw === "-" ? 0 : Number(deletedRaw);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      throw new Error(`invalid git numstat counts: ${addedRaw} ${deletedRaw}`);
    }
    const after = rest.slice(secondTab + 1);
    if (after.startsWith("\0")) {
      const previousEnd = after.indexOf("\0", 1);
      if (previousEnd === -1) {
        throw new Error("incomplete git numstat rename output");
      }
      const filenameEnd = after.indexOf("\0", previousEnd + 1);
      if (filenameEnd === -1) {
        throw new Error("incomplete git numstat rename output");
      }
      const filename = after.slice(previousEnd + 1, filenameEnd);
      if (filename === "") {
        throw new Error("incomplete git numstat rename output");
      }
      stats.set(filename, { additions, deletions });
      rest = after.slice(filenameEnd + 1);
      continue;
    }
    const nul = after.indexOf("\0");
    if (nul === -1) {
      throw new Error("incomplete git numstat output");
    }
    const filename = after.slice(0, nul);
    if (filename === "") {
      throw new Error("incomplete git numstat output");
    }
    stats.set(filename, { additions, deletions });
    rest = after.slice(nul + 1);
  }
  return stats;
}

/**
 * @param {NameStatusEntry[]} nameStatus
 * @param {Map<string, { additions: number, deletions: number }>} numstat
 * @returns {ChangedFile[]}
 */
export function mergeDiffEntries(nameStatus, numstat) {
  if (nameStatus.length !== numstat.size) {
    throw new Error("git name-status and numstat path counts differ");
  }
  return nameStatus.map((entry) => {
    const counts = numstat.get(entry.filename);
    if (counts === undefined) {
      throw new Error(`missing git numstat for ${entry.filename}`);
    }
    return {
      filename: entry.filename,
      previous_filename: entry.previous_filename,
      additions: counts.additions,
      deletions: counts.deletions
    };
  });
}

/**
 * @param {string} base
 * @param {string} head
 * @param {string[]} extraArgs
 * @returns {string}
 */
function gitDiff(base, head, extraArgs) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "diff",
      "-z",
      "--find-renames",
      ...extraArgs,
      base,
      head
    ],
    { encoding: "utf8" }
  );
}

/**
 * @param {ChangedFile[]} files
 * @param {string} filesJsonl
 * @param {string} pathsFile
 */
export function writeChangedFileOutputs(files, filesJsonl, pathsFile) {
  writeFileSync(
    filesJsonl,
    files
      .map((file) =>
        JSON.stringify({
          filename: file.filename,
          previous_filename: file.previous_filename,
          additions: file.additions,
          deletions: file.deletions
        })
      )
      .join("\n") + (files.length > 0 ? "\n" : ""),
    "utf8"
  );
  const paths = new Set();
  for (const file of files) {
    paths.add(file.filename);
    if (file.previous_filename) {
      paths.add(file.previous_filename);
    }
  }
  writeFileSync(
    pathsFile,
    [...paths].sort((a, b) => a.localeCompare(b)).join("\n") +
      (paths.size > 0 ? "\n" : ""),
    "utf8"
  );
}

/**
 * @returns {number}
 */
function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      "files-jsonl": { type: "string" },
      "paths-file": { type: "string" }
    }
  });
  /**
   * @param {string} name
   * @param {string | undefined} value
   * @returns {string | null}
   */
  const required = (name, value) => {
    if (typeof value !== "string" || value === "") {
      process.stderr.write(
        `collect-changed-files.mjs: --${name} is required\n`
      );
      return null;
    }
    return value;
  };
  const base = required("base", values.base);
  const head = required("head", values.head);
  const filesJsonl = required("files-jsonl", values["files-jsonl"]);
  const pathsFile = required("paths-file", values["paths-file"]);
  if (
    base === null ||
    head === null ||
    filesJsonl === null ||
    pathsFile === null
  ) {
    return 2;
  }
  try {
    writeChangedFileOutputs(
      mergeDiffEntries(
        parseNameStatus(gitDiff(base, head, ["--name-status"])),
        parseNumstat(gitDiff(base, head, ["--numstat"]))
      ),
      filesJsonl,
      pathsFile
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `collect-changed-files.mjs: unable to enumerate a complete base-to-head diff: ${message}\n`
    );
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
