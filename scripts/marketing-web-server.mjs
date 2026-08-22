import { spawn } from "node:child_process";

const port = process.env.PORT;
const baseUrl = process.env.APP_BASE_URL;
const publicBaseUrl = process.env.PUBLIC_APP_BASE_URL;

if (!port || !baseUrl || !publicBaseUrl) {
  throw new Error("PORT, APP_BASE_URL, and PUBLIC_APP_BASE_URL are required.");
}

const child = spawn("pnpm", ["exec", "next", "dev", "-p", port], {
  env: {
    ...process.env,
    APP_ENV: "test",
    AGENT_OUTBOX_BROWSER_FIXTURE: "1",
    APP_BASE_URL: baseUrl,
    PUBLIC_APP_BASE_URL: publicBaseUrl,
    PORT: port
  },
  stdio: "inherit"
});

for (const signal of /** @type {NodeJS.Signals[]} */ ([
  "SIGINT",
  "SIGTERM",
  "SIGHUP"
])) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
