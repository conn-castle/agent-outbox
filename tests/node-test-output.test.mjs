import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "scripts/run-node-tests.sh");

/**
 * @param {string} name
 * @returns {string}
 */
function fixture(name) {
  return path.join(ROOT, "tests/fixtures/node-test-output", name);
}

/**
 * This file runs under node --test. The product command does not. Clearing
 * the runner's private variables here is what lets the child execute files.
 *
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
  return env;
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} [extra]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runScript(args, extra) {
  return spawnSync("bash", [RUNNER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv(extra)
  });
}

/**
 * @param {string} stdout
 * @returns {string}
 */
function logPathFrom(stdout) {
  const match = stdout.match(/^log (.+)$/m);
  assert.ok(match?.[1], stdout);
  return path.resolve(ROOT, match[1]);
}

test("a passing run keeps the full log and the root stderr sidecar", () => {
  const result = runScript([fixture("quiet.mjs")], {
    NO_COLOR: "1",
    FORCE_COLOR: "1"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /^log \.agent-layer\/tmp\/node-test-logs\/.+\.log$/m
  );
  assert.match(result.stdout, /^stderr .+\.log\.stderr$/m);
  assert.match(result.stdout, /^outcome pass$/m);
  assert.doesNotMatch(result.stdout, /UNIQUE_PASS_NAME/);
  const logFile = logPathFrom(result.stdout);
  assert.match(readFileSync(logFile, "utf8"), /UNIQUE_PASS_NAME/);
  assert.match(
    result.stderr ?? "",
    /The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\./
  );
  assert.match(
    readFileSync(`${logFile}.stderr`, "utf8"),
    /The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\./
  );
});

test("warnings, skips, and failing todos stay visible and are not failures", () => {
  const result = runScript([fixture("diagnostics.mjs")]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const log = readFileSync(logPathFrom(result.stdout), "utf8");
  for (const marker of [
    "NODE_TEST_OUTPUT_STDOUT",
    "NODE_TEST_OUTPUT_STDERR",
    "NODE_TEST_OUTPUT_WARN",
    "NODE_TEST_OUTPUT_RAW_STDERR",
    "NODE_TEST_OUTPUT_EMIT_WARNING",
    "NODE_TEST_OUTPUT_DIAGNOSTIC",
    "::warning::keep-me",
    '{"level":"warn","message":"keep-json"}'
  ]) {
    assert.ok(result.stdout.includes(marker), marker);
    assert.ok(log.includes(marker), `log ${marker}`);
  }
  assert.match(result.stdout, /^skip skipped case # SKIP_REASON$/m);
  assert.match(result.stdout, /^todo todo that fails # TODO_REASON$/m);
  assert.match(result.stdout, /1 !== 2/);
  assert.match(result.stdout, /^outcome pass$/m);
  assert.doesNotMatch(result.stdout, /^fail [^0-9]/m);
  assert.doesNotMatch(result.stdout, /DIAGNOSTICS_PASS_NAME/);
  assert.match(log, /DIAGNOSTICS_PASS_NAME/);
});

test("a failing run stays nonzero and names the file", () => {
  const result = runScript([fixture("failure.mjs")]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout,
    /^fail INTENTIONAL_FAIL_NAME \(.+failure\.mjs\)$/m
  );
  assert.match(result.stdout, /1 !== 2/);
  assert.match(result.stdout, /^outcome fail$/m);
  const log = readFileSync(logPathFrom(result.stdout), "utf8");
  assert.match(log, /INTENTIONAL_FAIL_NAME/);
  assert.match(log, /1 !== 2/);
});
