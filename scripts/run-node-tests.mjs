import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ROOT } from "./repo-root.mjs";

const LOG_DIRECTORY = path.join(ROOT, ".agent-layer/tmp/node-test-logs");
const REPORTER_URL = pathToFileURL(
  path.join(ROOT, "scripts/node-test-stdio-reporter.mjs")
).href;
/** @type {readonly NodeJS.Signals[]} */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * @param {string[]} args
 * @param {string} logFile
 * @returns {string[]}
 */
export function nodeTestArguments(args, logFile) {
  return [
    "--test",
    "--test-reporter=spec",
    `--test-reporter-destination=${logFile}`,
    `--test-reporter=${REPORTER_URL}`,
    "--test-reporter-destination=stdout",
    ...args
  ];
}

/**
 * Signal status wins over a logging failure. A zero runner status does not.
 *
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {boolean} loggingFailed
 * @returns {{ exitCode: number, signal: NodeJS.Signals | null }}
 */
export function exitStatusForChild(code, signal, loggingFailed) {
  if (signal) {
    const number = os.constants.signals[signal];
    return {
      exitCode: typeof number === "number" ? 128 + number : 1,
      signal
    };
  }
  if (code === 0 && loggingFailed) {
    return { exitCode: 1, signal: null };
  }
  return { exitCode: code ?? 1, signal: null };
}

/**
 * @param {string} directory
 * @returns {string}
 */
function createUniqueLog(directory) {
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(
    directory,
    `${stamp}-${process.pid}-${randomBytes(4).toString("hex")}.log`
  );
  const fd = openSync(logFile, "wx");
  closeSync(fd);
  return logFile;
}

/**
 * @param {string} logFile
 */
function assertLogWritable(logFile) {
  const fd = openSync(logFile, "a");
  closeSync(fd);
}

/**
 * Test files run with NODE_TEST_CONTEXT set. A nested `node --test` that
 * inherits it skips every file, so the runner process must not see it.
 *
 * @param {string | null} logFile
 * @returns {NodeJS.ProcessEnv}
 */
function runnerEnv(logFile) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.WATCH_REPORT_DEPENDENCIES;
  if (logFile) {
    env.AGENT_OUTBOX_NODE_TEST_LOG = logFile;
  } else {
    delete env.AGENT_OUTBOX_NODE_TEST_LOG;
  }
  return env;
}

/**
 * The spec reporter keeps the complete runner stream, including passing test
 * names, diagnostics, and test stdout/stderr. Node 24.18's dot reporter is not
 * used because it prints only pass/fail marks and failure reports.
 *
 * @param {string[]} args
 * @param {{ logFile?: string, logDirectory?: string, stdio?: "inherit" | "pipe", forwardSignals?: boolean }} [options]
 * @returns {Promise<{ exitCode: number, signal: NodeJS.Signals | null, logFile: string | null, stdout: string, stderr: string }>}
 */
export async function runNodeTests(args, options = {}) {
  const stdioMode = options.stdio ?? "inherit";
  /** @type {Buffer[]} */
  const stderrChunks = [];
  /**
   * @param {string | Uint8Array} chunk
   */
  const writeStderr = (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
    if (stdioMode === "inherit") {
      process.stderr.write(chunk);
    }
  };

  const attemptedLog = options.logFile ?? options.logDirectory ?? LOG_DIRECTORY;
  let logFile = null;
  let loggingFailed = false;
  try {
    if (options.logFile) {
      assertLogWritable(options.logFile);
      logFile = options.logFile;
    } else {
      logFile = createUniqueLog(options.logDirectory ?? LOG_DIRECTORY);
    }
  } catch (error) {
    loggingFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`Failed to create node test log ${attemptedLog}: ${message}\n`);
    logFile = null;
  }

  const nodeArgs = logFile
    ? nodeTestArguments(args, logFile)
    : ["--test", ...args];
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  // Stay in the caller's process group. A new session would survive SIGKILL of
  // this process and would no longer receive the terminal's SIGINT or SIGHUP.
  const child = spawn(process.execPath, nodeArgs, {
    env: runnerEnv(logFile),
    stdio: [
      stdioMode === "inherit" ? "inherit" : "ignore",
      stdioMode === "inherit" ? "inherit" : "pipe",
      "pipe"
    ]
  });
  /**
   * @param {NodeJS.Signals} signal
   */
  const signalRunner = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // The runner has already exited.
    }
  };

  /** @type {Array<[NodeJS.Signals, () => void]>} */
  const listeners = [];
  if (options.forwardSignals) {
    for (const signal of FORWARDED_SIGNALS) {
      const listener = () => {
        signalRunner(signal);
      };
      process.on(signal, listener);
      listeners.push([signal, listener]);
    }
  }

  if (stdioMode === "pipe") {
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      stdoutChunks.push(chunk);
    });
  }
  child.stderr?.on("data", (/** @type {Buffer} */ chunk) => {
    writeStderr(chunk);
  });

  /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */
  const closed = await new Promise((resolve) => {
    let settled = false;
    /**
     * @param {{ code: number | null, signal: NodeJS.Signals | null }} value
     */
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      writeStderr(`Failed to start node test runner: ${error.message}\n`);
      loggingFailed = true;
      finish({ code: 1, signal: null });
    });
    child.once("close", (code, signal) => {
      finish({ code, signal });
    });
  });

  for (const [signal, listener] of listeners) {
    process.off(signal, listener);
  }

  if (logFile) {
    const runnerStderr = Buffer.concat(stderrChunks).toString("utf8");
    try {
      if (statSync(logFile).size === 0) {
        writeStderr(`Node test log is empty: ${logFile}\n`);
        loggingFailed = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`Failed to read node test log ${logFile}: ${message}\n`);
      loggingFailed = true;
    }
    if (runnerStderr.length > 0) {
      try {
        appendFileSync(logFile, `\n-- runner stderr --\n${runnerStderr}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStderr(
          `Failed to append runner stderr to ${logFile}: ${message}\n`
        );
        loggingFailed = true;
      }
    }
  }

  const status = exitStatusForChild(closed.code, closed.signal, loggingFailed);
  return {
    exitCode: status.exitCode,
    signal: status.signal,
    logFile,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8")
  };
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  const result = await runNodeTests(process.argv.slice(2), {
    forwardSignals: true
  });
  // Assigning exitCode lets pending stderr diagnostics flush. process.exit
  // can drop a write that has not drained.
  process.exitCode = result.exitCode;
}
