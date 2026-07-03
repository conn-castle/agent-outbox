import crypto from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

const port = 39010;
const baseURL = `http://127.0.0.1:${port}`;

// Scope every browser-fixture Docker resource to this run so parallel runs on a
// shared host never tear down each other's Postgres. This id is the single
// source of truth shared between the web server (which labels the resources it
// creates) and globalTeardown (which only removes resources carrying this run's
// label). The config module and globalTeardown execute in the same runner
// process, and the spawned web server inherits its environment, so setting it
// here reaches all three.
const runId =
  process.env.AGENT_OUTBOX_BROWSER_RUN_ID ??
  crypto.randomBytes(4).toString("hex");
process.env.AGENT_OUTBOX_BROWSER_RUN_ID = runId;

export default defineConfig({
  testDir: "./tests/browser",
  globalTeardown: "./scripts/browser-test-cleanup.mjs",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"] }
    }
  ],
  webServer: {
    command: `APP_BASE_URL=${baseURL} PUBLIC_APP_BASE_URL=${baseURL} PORT=${port} AGENT_OUTBOX_BROWSER_RUN_ID=${runId} exec node scripts/browser-web-server.mjs`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
