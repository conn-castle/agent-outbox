import { defineConfig } from "@playwright/test";

const port = 39011;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "marketing-capture.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL,
    browserName: "chromium",
    trace: "off"
  },
  webServer: {
    command: `APP_BASE_URL=${baseURL} PUBLIC_APP_BASE_URL=${baseURL} PORT=${port} exec node scripts/marketing-web-server.mjs`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
