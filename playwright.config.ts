import { defineConfig, devices } from "@playwright/test";

const port = 39010;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
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
    command: [
      "APP_ENV=test",
      "PORT=39010",
      `APP_BASE_URL=${baseURL}`,
      `PUBLIC_APP_BASE_URL=${baseURL}`,
      "AGENT_OUTBOX_BROWSER_FIXTURE=1",
      "DATABASE_APP_ROLE_URL=postgresql://browser-fixture.invalid/agent_outbox",
      "corepack pnpm exec next dev -p 39010"
    ].join(" "),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
