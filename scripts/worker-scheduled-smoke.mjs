import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_CRON_SCHEDULE } from "../src/server/scheduled.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_SMOKE_PORT = 38_001;
const READY_TIMEOUT_MS = 60_000;
const LOG_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 2_000;

/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForScheduledEndpoint() {
  const url = new URL(`http://127.0.0.1:${WORKER_SMOKE_PORT}/__scheduled`);
  url.searchParams.set("cron", RUNTIME_CRON_SCHEDULE);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (response.ok) {
        const body = await response.text();
        assert.match(body, /Ran scheduled event/);
        return;
      }
      lastError = new Error(`scheduled endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw lastError ?? new Error("scheduled endpoint did not become reachable");
}

/**
 * @param {() => string} getOutput
 */
async function waitForScheduledLog(getOutput) {
  const deadline = Date.now() + LOG_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (getOutput().includes('"operation":"runtime.scheduled.canary"')) {
      return;
    }
    await delay(250);
  }

  throw new Error("scheduled canary log was not emitted");
}

async function main() {
  if (!existsSync(path.join(ROOT, ".open-next/worker.js"))) {
    console.error("Worker scheduled smoke blocked: run `make build` first.");
    process.exitCode = 1;
    return;
  }

  let output = "";
  const worker = spawn(
    path.join(ROOT, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      "wrangler.jsonc",
      "--test-scheduled",
      "--local",
      "--port",
      String(WORKER_SMOKE_PORT),
      "--log-level",
      "log",
      "--show-interactive-dev-session=false"
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => {
    output += chunk;
  });
  worker.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    await waitForScheduledEndpoint();
    await waitForScheduledLog(() => output);
    console.log("Worker scheduled smoke canary passed.");
  } catch (error) {
    if (output) {
      console.error(output);
    }
    throw error;
  } finally {
    worker.kill("SIGTERM");
  }
}

await main();
