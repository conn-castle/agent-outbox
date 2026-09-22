import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "scripts/run-node-tests.sh");
/** @type {string[]} */
const scratchDirs = [];

test.after(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @param {string} name
 * @returns {string}
 */
function fixture(name) {
  return path.join(ROOT, "tests/fixtures/node-test-output", name);
}

/**
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function runnerEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`
  };
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} [extra]
 * @param {{ defaultLog?: boolean }} [options]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runScript(args, extra = {}, options = {}) {
  const env = { ...extra };
  if (
    !options.defaultLog &&
    env.AGENT_OUTBOX_NODE_TEST_LOG_PATH === undefined
  ) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "node-test-output-"));
    scratchDirs.push(dir);
    env.AGENT_OUTBOX_NODE_TEST_LOG_PATH = path.join(dir, "run.log");
  }
  return spawnSync("bash", [RUNNER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: runnerEnv(env)
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

test("a passing run omits the test name and writes the full log", () => {
  const result = runScript([fixture("quiet.mjs")], {}, { defaultLog: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /^log \.agent-layer\/tmp\/node-test-logs\/.+\.log$/m
  );
  assert.match(result.stdout, /^stderr .+\.log\.stderr$/m);
  assert.match(result.stdout, /^tests 1$/m);
  assert.match(result.stdout, /^pass 1$/m);
  assert.match(result.stdout, /^fail 0$/m);
  assert.match(result.stdout, /^outcome pass$/m);
  assert.doesNotMatch(result.stdout, /UNIQUE_PASS_NAME/);
  const logFile = logPathFrom(result.stdout);
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /UNIQUE_PASS_NAME/);
  assert.equal(
    result.stdout.includes(logFile) ||
      result.stdout.includes(path.relative(ROOT, logFile)),
    true
  );
});

test("warnings and diagnostics stay on stdout and in the log", () => {
  const result = runScript([fixture("diagnostics.mjs")]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const log = readFileSync(logPathFrom(result.stdout), "utf8");
  const markers = [
    "NODE_TEST_OUTPUT_STDOUT",
    "NODE_TEST_OUTPUT_STDERR",
    "NODE_TEST_OUTPUT_WARN",
    "NODE_TEST_OUTPUT_RAW_STDERR",
    "NODE_TEST_OUTPUT_EMIT_WARNING",
    "NODE_TEST_OUTPUT_DIAGNOSTIC",
    "::warning::keep-me",
    '{"level":"warn","message":"keep-json"}'
  ];
  for (const marker of markers) {
    assert.ok(result.stdout.includes(marker), marker);
    assert.ok(log.includes(marker), `log ${marker}`);
  }
  assert.doesNotMatch(result.stdout, /DIAGNOSTICS_PASS_NAME/);
  assert.match(log, /DIAGNOSTICS_PASS_NAME/);
});

test("a failing run stays nonzero and shows the assertion", () => {
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

test("skips and failing todos keep their meaning", () => {
  const result = runScript([fixture("annotations.mjs")]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^skip skipped case # SKIP_REASON$/m);
  assert.match(result.stdout, /^todo todo that fails # TODO_REASON$/m);
  assert.match(result.stdout, /1 !== 2/);
  assert.match(result.stdout, /^fail 0$/m);
  assert.match(result.stdout, /^todo 1$/m);
  assert.match(result.stdout, /^outcome pass$/m);
  assert.doesNotMatch(result.stdout, /^fail [^0-9]/m);
});

test("root stderr still shows the external NO_COLOR and FORCE_COLOR warning", () => {
  const result = runScript([fixture("quiet.mjs")], {
    NO_COLOR: "1",
    FORCE_COLOR: "1"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\./
  );
  const sidecar = readFileSync(`${logPathFrom(result.stdout)}.stderr`, "utf8");
  assert.match(
    sidecar,
    /The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\./
  );
});

test("a log that cannot be created fails visibly and does not run tests", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "node-test-log-"));
  try {
    const blocker = path.join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const result = runScript([fixture("quiet.mjs")], {
      AGENT_OUTBOX_NODE_TEST_LOG_PATH: path.join(blocker, "node.log")
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not a directory|Already exists|ENOTDIR/);
    assert.doesNotMatch(result.stdout, /UNIQUE_PASS_NAME|outcome /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit log path is not reused by a nested run", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "node-test-output-"));
  scratchDirs.push(dir);
  const shared = path.join(dir, "shared.log");
  const result = runScript([fixture("spawn-quiet.mjs")], {
    AGENT_OUTBOX_NODE_TEST_LOG_PATH: shared
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const logs = [...result.stdout.matchAll(/^log (.+)$/gm)].map(
    (match) => match[1]
  );
  const sharedResolved = path.resolve(shared);
  const others = logs
    .map((line) => path.resolve(ROOT, line ?? ""))
    .filter((line) => line !== sharedResolved);
  assert.ok(others.length >= 1, result.stdout);
  const parent = readFileSync(shared, "utf8");
  assert.match(parent, /nested runner/);
  assert.equal(parent.includes("\0"), false);
  assert.match(readFileSync(others[0], "utf8"), /UNIQUE_PASS_NAME/);
});

test("an interrupted run names the log and stays nonzero", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "node-test-output-"));
  scratchDirs.push(dir);
  const logFile = path.join(dir, "hang.log");
  const child = spawn("bash", [RUNNER, fixture("hang.mjs")], {
    cwd: ROOT,
    detached: true,
    env: runnerEnv({
      AGENT_OUTBOX_NODE_TEST_LOG_PATH: logFile
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const started = Date.now();
    while (!stdout.includes("\n") && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(stdout.includes(`log ${logFile}\n`), `${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(child.pid);
    process.kill(-child.pid, "SIGINT");
    const closed = await Promise.race([
      once(child, "close").then((value) => ({ timedOut: false, value })),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            timedOut: true,
            value: /** @type {[number | null, NodeJS.Signals | null]} */ ([
              null,
              null
            ])
          });
        }, 5000);
      })
    ]);
    assert.equal(closed.timedOut, false, `${stdout}\n${stderr}`);
    const [code, signal] = closed.value;
    assert.ok(code !== 0 || signal, `${code} ${signal}\n${stdout}\n${stderr}`);
    assert.match(stdout, /^outcome interrupted$/m, stdout);
    assert.match(stdout, /^stderr /m, stdout);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The runner has already exited.
      }
    }
  }
});
