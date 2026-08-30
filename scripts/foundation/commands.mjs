import { spawnSync } from "node:child_process";

import { ROOT } from "../repo-root.mjs";

/**
 * @typedef {{
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   error?: Error & { code?: string },
 *   stdout?: unknown,
 *   stderr?: unknown
 * }} CommandResult
 */

const COMMAND_TIMEOUT_MS = 30_000;

/**
 * @param {CommandResult} result
 * @returns {{ status: number | null, signal: NodeJS.Signals | null, error: string | null }}
 */
export function redactCommandResult(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.code ?? result.error?.message ?? null
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function runQuiet(command, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/**
 * @param {unknown} error
 * @returns {string | null}
 */
export function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : null;
  }

  return null;
}
