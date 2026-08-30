import { spawnSync } from "node:child_process";

import { ROOT } from "../repo-root.mjs";

export const WRANGLER_CONFIG_RELATIVE_PATH = "wrangler.jsonc";

/**
 * @param {string} tag
 * @param {{ cwd?: string }} [options]
 */
export function localTagCommit(tag, options = {}) {
  const result = spawnSync(
    "git",
    ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`],
    { cwd: options.cwd ?? ROOT, encoding: "utf8" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status === 1) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(`failed to inspect ${tag}`);
  }
  return result.stdout.trim();
}

/**
 * @param {string} sha
 * @param {string} relativePath
 * @param {{ cwd?: string }} [options]
 */
export function readGitFile(sha, relativePath, options = {}) {
  const result = spawnSync("git", ["show", `${sha}:${relativePath}`], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `unable to read ${relativePath} at ${sha}: ${(result.stderr ?? "").trim()}`
    );
  }
  return result.stdout;
}
