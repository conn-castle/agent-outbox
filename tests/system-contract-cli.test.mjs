import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const valid = JSON.parse(
  readFileSync(path.join(ROOT, "system-contract.json"), "utf8")
);

/** @param {import("node:test").TestContext} t @param {string | undefined} payload */
function fixture(t, payload) {
  const tempRoot = path.join(
    ROOT,
    ".agent-layer/tmp/system-contract-cli-tests"
  );
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const relative of [
    "scripts",
    "src",
    "docs",
    "worker",
    "cli",
    "package.json",
    "wrangler.jsonc"
  ]) {
    cpSync(path.join(ROOT, relative), path.join(root, relative), {
      recursive: true
    });
  }
  if (payload !== undefined)
    writeFileSync(path.join(root, "system-contract.json"), payload);
  return root;
}

/** @param {string} root @param {string[]} args */
function run(root, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8"
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

/** @param {string} root @param {string} action */
function observedError(root, action) {
  const result = run(root, [
    "--input-type=module",
    "-e",
    `
    try { ${action}; process.exitCode = 3; }
    catch (error) {
      console.log(JSON.stringify({ name: error.name, code: error.code,
        message: error.message, actual: error.actual, expected: error.expected,
        operator: error.operator, syscall: error.syscall, path: error.path }));
    }
  `
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

const readAction = `const script = await import('./scripts/system-contract.mjs'); script.readSystemContract()`;

test("CLI missing/extra fields retain native assertion diffs and exported error details", (t) => {
  const missing = { ...valid };
  delete missing.billing_downgrade_grace_days;
  for (const [raw, diff] of [
    [missing, /-\s+'billing_downgrade_grace_days'/],
    [{ ...valid, extra: true }, /\+\s+'extra'/]
  ]) {
    const root = fixture(t, JSON.stringify(raw));
    for (const command of ["check", "generate", "unknown"]) {
      const result = run(root, ["scripts/system-contract.mjs", command]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /AssertionError \[ERR_ASSERTION\]: system-contract.json fields must be exact\n/
      );
      assert.match(result.stderr, diff);
      assert.match(result.stderr, /code: 'ERR_ASSERTION'/);
      assert.match(result.stderr, /operator: 'deepStrictEqual'/);
    }
    const error = observedError(root, readAction);
    assert.equal(error.name, "AssertionError");
    assert.equal(error.code, "ERR_ASSERTION");
    assert.match(error.message, /^system-contract.json fields must be exact\n/);
    assert.match(error.message, diff);
    assert.deepEqual(error.actual, Object.keys(raw).sort());
    assert.deepEqual(error.expected, Object.keys(valid).sort());
    assert.equal(error.operator, "deepStrictEqual");
    assert.deepEqual(
      observedError(root, `await import('./scripts/worker-deploy.mjs')`),
      error
    );
  }
});

test("CLI keeps ordinary validation, JSON.parse and filesystem errors", (t) => {
  const cases = [
    ["null", "TypeError", "system-contract.json must contain an object."],
    ["[]", "TypeError", "system-contract.json must contain an object."],
    [
      JSON.stringify({ ...valid, raw_file_bytes: 0 }),
      "TypeError",
      "system-contract.json raw_file_bytes must be a positive safe integer."
    ],
    [
      JSON.stringify({ ...valid, scheduled_cleanup_cron: " " }),
      "TypeError",
      "system-contract.json scheduled_cleanup_cron must be a non-empty string."
    ],
    [
      JSON.stringify({ ...valid, hosted_app_base_url: "http://app.example" }),
      "TypeError",
      "system-contract.json hosted_app_base_url must be an absolute HTTPS origin without credentials or a trailing slash."
    ],
    [
      JSON.stringify({
        ...valid,
        hosted_website_base_url: valid.hosted_app_base_url
      }),
      "TypeError",
      "system-contract.json hosted_website_base_url must differ from hosted_app_base_url."
    ],
    [
      JSON.stringify({ ...valid, output_page_default_limit: 101 }),
      "RangeError",
      "system-contract.json output_page_default_limit must not exceed output_page_max_limit."
    ],
    [
      JSON.stringify({ ...valid, default_device_poll_interval_seconds: 3601 }),
      "RangeError",
      "system-contract.json default_device_poll_interval_seconds must not exceed 3600."
    ],
    [
      JSON.stringify({ ...valid, control_plane_setup_code_expiry_seconds: 4 }),
      "RangeError",
      "system-contract.json default_device_poll_interval_seconds must not exceed control_plane_setup_code_expiry_seconds."
    ],
    [
      "{",
      "SyntaxError",
      "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
    ],
    [undefined, "Error", undefined]
  ];
  for (const [payload, name, message] of cases) {
    const root = fixture(t, payload);
    const error = observedError(root, readAction);
    assert.equal(error.name, name);
    if (message !== undefined) assert.equal(error.message, message);
    else {
      assert.equal(error.code, "ENOENT");
      assert.equal(error.syscall, "open");
      assert.equal(error.path, path.join(root, "system-contract.json"));
    }
    for (const command of ["check", "generate", "unknown"]) {
      const result = run(root, ["scripts/system-contract.mjs", command]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(`${name}: ${error.message}`));
    }
    // Worker imports must still read and validate the contract at initialization.
    assert.deepEqual(
      observedError(root, `await import('./scripts/worker-deploy.mjs')`),
      error
    );
  }
});

test("helper imports are lazy and explicit readers observe subsequent file contents", (t) => {
  for (const payload of [undefined, "{", "null"]) {
    const root = fixture(t, payload);
    const result = run(root, [
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import * as script from './scripts/system-contract.mjs';
      import { validateWranglerCronSchedule } from './scripts/foundation/wrangler-contracts.mjs';
      assert.deepEqual(Object.keys(script).sort(), [
        'parseJsonc', 'readSystemContract', 'renderGeneratedGoSystemContract',
        'stripJsonComments', 'systemContractDriftFailures', 'validateSystemContract'
      ]);
      assert.deepEqual(script.parseJsonc('{/*comment*/"ok":true,}'), {ok: true});
      assert.deepEqual(validateWranglerCronSchedule('{"triggers":{"crons":["17 * * * *"]}}', '17 * * * *'), []);
      assert.ok(Object.isFrozen(script.validateSystemContract(${JSON.stringify(valid)})));
      writeFileSync('system-contract.json', ${JSON.stringify(JSON.stringify(valid))});
      assert.equal(script.readSystemContract().rawFileBytes, ${JSON.stringify(valid.raw_file_bytes)});
      writeFileSync('system-contract.json', JSON.stringify({ ...${JSON.stringify(valid)}, raw_file_bytes: 1 }));
      assert.equal(script.readSystemContract().rawFileBytes, 1);
      assert.ok(script.systemContractDriftFailures().some(f => f.includes('generated.go is stale')));
      console.log('lazy helpers and fresh reads passed');
    `
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "lazy helpers and fresh reads passed\n");
    assert.equal(result.stderr, "");
  }
});

test("generate/check/usage keep statuses, output, drift detection and identical Go bytes", (t) => {
  const root = fixture(t, JSON.stringify(valid));
  const generatedPath = path.join(
    root,
    "cli/internal/foundation/system_contract_generated.go"
  );
  const expected = readFileSync(generatedPath);
  for (const command of [undefined, "unknown"]) {
    const result = run(root, [
      "scripts/system-contract.mjs",
      ...(command ? [command] : [])
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Usage: node scripts/system-contract.mjs <generate|check>\n"
    );
  }
  writeFileSync(generatedPath, "stale\n");
  const stale = run(root, ["scripts/system-contract.mjs", "check"]);
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, "");
  assert.match(
    stale.stderr,
    /AssertionError \[ERR_ASSERTION\]: cli\/internal\/foundation\/system_contract_generated.go is stale; run node scripts\/system-contract.mjs generate\./
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = run(root, ["scripts/system-contract.mjs", "generate"]);
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(
      generated.stdout,
      "Generated cli/internal/foundation/system_contract_generated.go.\n"
    );
    assert.equal(generated.stderr, "");
    assert.deepEqual(readFileSync(generatedPath), expected);
    const checked = run(root, ["scripts/system-contract.mjs", "check"]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.stdout, "System contract drift checks passed.\n");
    assert.equal(checked.stderr, "");
  }
});
