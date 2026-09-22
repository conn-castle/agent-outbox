import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  exitStatusForChild,
  nodeTestArguments,
  runNodeTests
} from "../scripts/run-node-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "scripts/run-node-tests.mjs");

/**
 * @param {string} name
 * @returns {string}
 */
function fixture(name) {
  return path.join(ROOT, "tests/fixtures/node-test-output", name);
}

function procAvailable() {
  try {
    return statSync("/proc/self/stat").isFile();
  } catch {
    return false;
  }
}

function devFullAvailable() {
  try {
    return statSync("/dev/full").isCharacterDevice();
  } catch {
    return false;
  }
}

/**
 * @param {number} pid
 * @returns {number}
 */
function processGroup(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return Number(fields[2]);
}

/**
 * @param {number} pid
 * @returns {number[]}
 */
function childPids(pid) {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * @returns {string[]}
 */
function hangProcesses() {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`).toString("utf8");
      if (command.includes("fixtures/node-test-output/hang.mjs")) {
        found.push(command.replaceAll("\0", " "));
      }
    } catch {
      // The process exited while it was being read.
    }
  }
  return found;
}

/**
 * @param {string} stdout
 * @returns {string}
 */
function logPathFrom(stdout) {
  const matches = [...stdout.matchAll(/^log (.+)$/gm)];
  assert.ok(matches.length > 0, stdout);
  return path.resolve(matches[matches.length - 1][1]);
}

/**
 * @param {string[]} args
 * @param {Parameters<typeof runNodeTests>[1]} [options]
 */
async function runFixture(args, options) {
  const result = await runNodeTests(args, { stdio: "pipe", ...options });
  const detail = `${result.stdout}\n${result.stderr}`;
  return { ...result, detail };
}

// Reporter flags come first. Caller flags must stay after them so
// --test-concurrency=1 is not dropped or reordered away from node --test.
test("node test arguments keep caller flags after the spec log and stdio reporter", () => {
  const args = nodeTestArguments(
    ["--test-concurrency=1", "tests/*.test.mjs"],
    "/tmp/node-test.log"
  );
  assert.deepEqual(args.slice(0, 2), ["--test", "--test-reporter=spec"]);
  assert.equal(args[2], "--test-reporter-destination=/tmp/node-test.log");
  assert.match(args[3], /^--test-reporter=file:/);
  assert.equal(args[4], "--test-reporter-destination=stdout");
  assert.deepEqual(args.slice(5), ["--test-concurrency=1", "tests/*.test.mjs"]);
});

test("child signal status is preserved when logging also fails", () => {
  assert.deepEqual(exitStatusForChild(0, null, false), {
    exitCode: 0,
    signal: null
  });
  assert.deepEqual(exitStatusForChild(0, null, true), {
    exitCode: 1,
    signal: null
  });
  assert.deepEqual(exitStatusForChild(7, null, true), {
    exitCode: 7,
    signal: null
  });
  assert.deepEqual(exitStatusForChild(null, "SIGKILL", true), {
    exitCode: 128 + os.constants.signals.SIGKILL,
    signal: "SIGKILL"
  });
});

test("package scripts keep the ordinary node test entrypoints on the runner", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  assert.equal(
    packageJson.scripts.test,
    "node scripts/run-node-tests.mjs tests/*.test.mjs"
  );
  assert.equal(
    packageJson.scripts["test:database"],
    "node scripts/run-node-tests.mjs --test-concurrency=1 tests/*.test.mjs"
  );
  assert.ok(packageJson.scripts.check.includes("corepack pnpm run test"));
});

test("a quiet pass omits the passing name and keeps it in the log", async () => {
  const result = await runFixture([fixture("quiet.mjs")]);
  assert.equal(result.exitCode, 0, result.detail);
  assert.match(result.stdout, /^outcome pass$/m);
  assert.match(result.stdout, /^tests 1$/m);
  assert.match(result.stdout, /^pass 1$/m);
  assert.match(result.stdout, /^fail 0$/m);
  assert.doesNotMatch(result.stdout, /✔/);
  assert.doesNotMatch(result.stdout, /quiet pass/);
  const logFile = logPathFrom(result.stdout);
  assert.ok(
    logFile.includes(
      `${path.sep}.agent-layer${path.sep}tmp${path.sep}node-test-logs${path.sep}`
    ),
    logFile
  );
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /quiet pass/);
  assert.match(log, /✔/);
});

test("warnings and unclassified output stay on stdio and in the log", async () => {
  const result = await runFixture([fixture("diagnostics.mjs")]);
  assert.equal(result.exitCode, 0, result.detail);
  assert.match(result.stdout, /^outcome pass$/m);
  assert.doesNotMatch(result.stdout, /✔/);
  assert.doesNotMatch(result.stdout, /diagnostics pass/);
  const log = readFileSync(logPathFrom(result.stdout), "utf8");
  for (const marker of [
    "NODE_TEST_OUTPUT_STDOUT",
    "NODE_TEST_OUTPUT_STDERR",
    "NODE_TEST_OUTPUT_WARN",
    "NODE_TEST_OUTPUT_EMIT_WARNING",
    "NODE_TEST_OUTPUT_DIAGNOSTIC"
  ]) {
    assert.match(result.stdout, new RegExp(marker), result.detail);
    assert.match(log, new RegExp(marker));
  }
  assert.match(log, /diagnostics pass/);
  assert.match(log, /✔/);
});

test("a failing assertion reports details without passing-test names", async () => {
  const result = await runFixture([fixture("failure.mjs")]);
  assert.equal(result.exitCode, 1, result.detail);
  assert.match(result.stdout, /^outcome fail$/m);
  assert.match(result.stdout, /NODE_TEST_OUTPUT_ASSERTION/);
  assert.match(result.stdout, /NODE_TEST_OUTPUT_CHILD_ASSERTION/);
  assert.match(result.stdout, /failure file asserts/);
  assert.match(result.stdout, /failure file child/);
  assert.doesNotMatch(result.stdout, /failure file passes/);
  assert.doesNotMatch(result.stdout, /✔/);
  const log = readFileSync(logPathFrom(result.stdout), "utf8");
  assert.match(log, /failure file passes/);
  assert.match(log, /NODE_TEST_OUTPUT_ASSERTION/);
  assert.match(log, /NODE_TEST_OUTPUT_CHILD_ASSERTION/);
  assert.match(log, /✔/);
});

test("a log that cannot be created is visible and does not hide runner output", async () => {
  const blocker = path.join(
    os.tmpdir(),
    `agent-outbox-node-test-log-blocker-${process.pid}`
  );
  writeFileSync(blocker, "not a directory");
  try {
    const passing = await runFixture([fixture("quiet.mjs")], {
      logDirectory: path.join(blocker, "logs")
    });
    assert.notEqual(passing.exitCode, 0);
    assert.equal(passing.logFile, null);
    assert.match(passing.stderr, /Failed to create node test log/);
    assert.match(passing.stdout, /quiet pass/);
    assert.match(passing.stdout, /✔/);

    const failing = await runFixture([fixture("failure.mjs")], {
      logDirectory: path.join(blocker, "logs")
    });
    assert.equal(failing.exitCode, 1, failing.detail);
    assert.match(failing.stderr, /Failed to create node test log/);
    assert.match(failing.stdout, /NODE_TEST_OUTPUT_ASSERTION/);
  } finally {
    rmSync(blocker, { force: true });
  }
});

test(
  "a log write failure stays visible and non-zero",
  {
    skip: devFullAvailable()
      ? false
      : "/dev/full is not a character device on this platform"
  },
  async () => {
    const result = await runFixture([fixture("quiet.mjs")], {
      logFile: "/dev/full"
    });
    assert.notEqual(result.exitCode, 0, result.detail);
    assert.match(result.detail, /ENOSPC|no space left on device/);
    assert.doesNotMatch(result.stdout, /^outcome pass$/m);
  }
);

test("a todo failure keeps its error without a fail label", async () => {
  const result = await runFixture([fixture("todo.mjs")]);
  assert.equal(result.exitCode, 0, result.detail);
  assert.match(result.stdout, /^outcome pass$/m);
  assert.match(result.stdout, /^todo 1$/m);
  assert.match(result.stdout, /^fail 0$/m);
  assert.match(result.stdout, /NODE_TEST_OUTPUT_TODO/);
  const failLines = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("fail "));
  assert.deepEqual(failLines, ["fail 0"]);
});

test("the CLI reports an ordinary failure and its log path", () => {
  const result = spawnSync(process.execPath, [RUNNER, fixture("failure.mjs")], {
    encoding: "utf8"
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^log /m);
  assert.match(result.stdout, /^outcome fail$/m);
  assert.match(result.stdout, /NODE_TEST_OUTPUT_ASSERTION/);
  assert.doesNotMatch(result.stdout, /failure file passes/);
});

test(
  "SIGTERM keeps the test runner exit status",
  { timeout: 10_000 },
  async () => {
    const child = spawn(process.execPath, [RUNNER, fixture("hang.mjs")], {
      detached: true,
      stdio: "ignore"
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(child.exitCode, null);
      const wrapperPid = child.pid;
      assert.equal(typeof wrapperPid, "number");
      child.kill("SIGTERM");
      const [code, signal] = await once(child, "close");
      assert.equal(signal, null);
      assert.equal(code, 1);
    } finally {
      const wrapperPid = child.pid;
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        typeof wrapperPid === "number"
      ) {
        if (procAvailable()) {
          try {
            process.kill(-processGroup(wrapperPid), "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }
    }
  }
);

test(
  "SIGINT prints the log path and outcome and leaves no runner",
  {
    timeout: 10_000,
    skip: procAvailable() ? false : "/proc is not available on this platform"
  },
  async () => {
    const child = spawn(process.execPath, [RUNNER, fixture("hang.mjs")], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      stdout += chunk.toString("utf8");
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(child.exitCode, null);
      const wrapperPid = child.pid;
      assert.equal(typeof wrapperPid, "number");
      if (typeof wrapperPid !== "number") {
        return;
      }
      const runners = childPids(wrapperPid);
      assert.ok(runners.length > 0, "expected a node --test child");
      assert.equal(processGroup(runners[0]), processGroup(wrapperPid));
      child.kill("SIGINT");
      const [code, signal] = await once(child, "close");
      assert.equal(signal, null);
      assert.equal(code, 1);
      assert.match(stdout, /^log /m);
      assert.match(stdout, /^outcome /m);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(hangProcesses(), []);
    } finally {
      const wrapperPid = child.pid;
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        typeof wrapperPid === "number"
      ) {
        try {
          process.kill(-processGroup(wrapperPid), "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
  }
);
