import { spawn } from "node:child_process";
import path from "node:path";

import { parseEnv } from "./dotenv.mjs";
import { existsSync, readFileSync } from "node:fs";

const envPath = path.resolve(".env");
const localEnv = existsSync(envPath)
  ? Object.fromEntries(parseEnv(readFileSync(envPath, "utf8")))
  : {};

function localPort() {
  const port = localEnv.PORT;
  if (!port) {
    throw new Error("PORT is required in .env for local development");
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  for (const name of ["APP_BASE_URL", "PUBLIC_APP_BASE_URL"]) {
    const value = localEnv[name];
    if (!value) {
      throw new Error(`${name} is required in .env for local development`);
    }
    const url = new URL(value);
    if (url.port !== port) {
      throw new Error(`${name} must use PORT ${port}`);
    }
  }

  return port;
}

const nextBin = path.join("node_modules", ".bin", "next");
const child = spawn(nextBin, ["dev", "-p", localPort()], {
  env: { ...process.env, ...localEnv },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
