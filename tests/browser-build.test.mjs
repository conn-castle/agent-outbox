import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { getNextConfigEnv } from "next/dist/lib/static-env.js";
import {
  browserBuildConfig,
  browserBuildEnvironment
} from "../scripts/browser-build-config.ts";

const testEnvironment = {
  APP_ENV: "test",
  APP_BASE_URL: "http://127.0.0.1:39010",
  PUBLIC_APP_BASE_URL: "http://127.0.0.1:39010",
  AGENT_OUTBOX_BROWSER_BUILD: "1"
};

test("browser compilation cannot inherit a database from the shell or Next dotenv loading", () => {
  const parent = {
    DATABASE_APP_ROLE_URL: "postgresql://developer.invalid/private"
  };
  const environment = browserBuildEnvironment(parent);
  assert.equal(environment.DATABASE_APP_ROLE_URL, "");
  assert.equal(
    parent.DATABASE_APP_ROLE_URL,
    "postgresql://developer.invalid/private"
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { createRequire } = require('node:module');
    const nextRequire = createRequire(require.resolve('next/package.json'));
    const { processEnv } = nextRequire('@next/env');
    processEnv([{ path: '.env', contents: 'DATABASE_APP_ROLE_URL=postgresql://dotenv.invalid/private', env: {} }], process.cwd());
    process.stdout.write(JSON.stringify(process.env.DATABASE_APP_ROLE_URL));
  `
    ],
    { env: environment, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), "");
});

test("browser builds isolate output and reject production or remote origins", () => {
  const config = browserBuildConfig(testEnvironment);
  assert.equal(config.distDir, ".next-browser");
  assert.equal(config.typescript.tsconfigPath, "tsconfig.browser.json");
  for (const APP_ENV of [undefined, "development", "production"]) {
    assert.throws(() => browserBuildConfig({ ...testEnvironment, APP_ENV }), {
      message: "Browser builds require APP_ENV=test."
    });
  }
  for (const key of ["APP_BASE_URL", "PUBLIC_APP_BASE_URL"]) {
    for (const value of [
      undefined,
      "",
      "not a URL",
      "https://example.com",
      "http://0.0.0.0:39010"
    ]) {
      assert.throws(
        () => browserBuildConfig({ ...testEnvironment, [key]: value }),
        { message: `Browser builds require a loopback HTTP ${key}.` }
      );
    }
  }
  const normal = browserBuildConfig({
    APP_ENV: "production",
    AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE: "1"
  });
  assert.equal(normal.distDir, ".next");
  assert.equal(normal.typescript.tsconfigPath, "tsconfig.json");
  assert.equal(normal.env.AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE, "0");
});

// Exercise the real gate implementations with Next's configured compile-time
// constants, against hostile runtime flags. These unit tests model substitution;
// they do not exercise Next's compiler integration or replace full-build checks.
for (const [file, exportName, flag] of [
  [
    "human-review-fixture-gate.ts",
    "humanBrowserFixtureEnabled",
    "AGENT_OUTBOX_BROWSER_FIXTURE"
  ],
  [
    "caller-connect-clerk-fixture.ts",
    "callerConnectClerkFixtureEnabled",
    "AGENT_OUTBOX_CONNECT_CLERK_FIXTURE"
  ]
]) {
  test(`${exportName} cannot be enabled at runtime in a deployable build`, () => {
    const gate = compiledGate(file, exportName, false);
    assert.equal(
      gate({
        APP_ENV: "test",
        [flag]: "1",
        AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE: "1",
        AGENT_OUTBOX_BROWSER_BUILD: "1"
      }),
      false
    );
  });
  test(`${exportName} requires test environment and explicit fixture flag in test builds`, () => {
    const gate = compiledGate(file, exportName, true);
    assert.equal(gate({ APP_ENV: "test", [flag]: "1" }), true);
    assert.equal(gate({ APP_ENV: "production", [flag]: "1" }), false);
    assert.equal(gate({ APP_ENV: "test" }), false);
    assert.equal(gate({ [flag]: "1" }), false);
  });
}

/** @param {string} file @param {string} exportName @param {boolean} enabled */
function compiledGate(file, exportName, enabled) {
  const config = browserBuildConfig(enabled ? testEnvironment : {});
  const definitions = getNextConfigEnv(
    // This Next helper only reads env; other resolved Next options are unused.
    /** @type {import("next/dist/server/config-shared").NextConfigComplete} */ (
      /** @type {unknown} */ (config)
    )
  );
  definitions["process.env.NODE_ENV"] = "production";
  let source = readFileSync(
    new URL(`../src/server/${file}`, import.meta.url),
    "utf8"
  );
  for (const [key, value] of Object.entries(definitions)) {
    source = source.replaceAll(key, JSON.stringify(value));
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  /** @param {Record<string, string>} environment */
  return (environment) => {
    const exports = {};
    vm.runInNewContext(compiled, { exports, process: { env: environment } });
    return /** @type {Record<string, () => boolean>} */ (exports)[exportName]();
  };
}
