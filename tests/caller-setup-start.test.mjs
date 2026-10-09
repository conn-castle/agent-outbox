import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import {
  handleConnectBrowserStartRequest,
  handleConnectDeviceStartRequest
} from "../src/server/caller-connect.ts";
import {
  handleRevokeBrowserStartRequest,
  handleRevokeDeviceStartRequest,
  handleRotateBrowserStartRequest,
  handleRotateDeviceStartRequest
} from "../src/server/caller-credential-operations.ts";
import { queryResult } from "./helpers/fake-query.mjs";
import { withProcessEnv } from "./helpers/process-env.mjs";

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";
const CALLER_ID = "00000000-0000-4000-8000-000000000003";
const SETUP_REQUEST_ID = "10000000-0000-4000-8000-000000000501";
const CONTEXT = {
  requestId: "req-setup-start",
  correlationId: "corr-setup-start"
};
const VALID_ENV = {
  CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
  DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
  PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
};

const START_HANDLERS = {
  connect: {
    browser: handleConnectBrowserStartRequest,
    device: handleConnectDeviceStartRequest
  },
  rotate: {
    browser: handleRotateBrowserStartRequest,
    device: handleRotateDeviceStartRequest
  },
  revoke: {
    browser: handleRevokeBrowserStartRequest,
    device: handleRevokeDeviceStartRequest
  }
};

const CONNECT_MESSAGES = {
  validationFailed: "Caller connect request failed validation.",
  temporarilyUnavailable: "Caller connect is temporarily unavailable."
};
const CREDENTIAL_OPERATION_MESSAGES = {
  validationFailed: "Caller credential operation request failed validation.",
  temporarilyUnavailable:
    "Caller credential operation is temporarily unavailable."
};
const MESSAGES = {
  connect: CONNECT_MESSAGES,
  rotate: CREDENTIAL_OPERATION_MESSAGES,
  revoke: CREDENTIAL_OPERATION_MESSAGES
};

/**
 * Builds a valid setup-start body with the fields required by the operation
 * and flow.
 *
 * @param {"connect" | "rotate" | "revoke"} operation
 * @param {"browser" | "device"} flow
 */
function validBody(operation, flow) {
  return {
    ...(operation === "connect" ? {} : { caller_id: CALLER_ID }),
    local_caller_name: "steward-email",
    ...(operation === "connect" ? { display_name: "Steward Email" } : {}),
    ...(flow === "browser"
      ? { callback_url: "http://127.0.0.1:49152/callback" }
      : {})
  };
}

/**
 * Builds a POST request for the operation and flow, omitting the trusted IP
 * header when ipAddress is null.
 *
 * @param {"connect" | "rotate" | "revoke"} operation
 * @param {"browser" | "device"} flow
 * @param {string | null} [ipAddress]
 */
function startRequest(operation, flow, ipAddress = "203.0.113.77") {
  return new Request(
    `https://app.agent-outbox.dev/api/caller/${operation}/${flow}/start`,
    {
      method: "POST",
      headers: ipAddress === null ? {} : { "cf-connecting-ip": ipAddress }
    }
  );
}

/**
 * Records the leading words of every statement, including savepoint control
 * statements, and answers the IP limit and setup insert through `onInsert`.
 *
 * @param {() => Array<Record<string, unknown>>} onInsert
 */
function scriptedTransaction(onInsert) {
  /** @type {string[]} */
  const statements = [];
  let transactions = 0;
  /** @type {typeof import("../src/server/database.ts").runProductTransaction} */
  const runProductTransaction = async (
    _connectionString,
    _context,
    callback
  ) => {
    transactions += 1;
    return callback(
      /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
        /** @type {unknown} */ (
          async (/** @type {{ sql: string }} */ { sql }) => {
            const text = sql.trim();
            if (text.includes("agent_outbox_ip_quota_windows")) {
              statements.push("ip limit");
              return queryResult([{ used_units: "1" }]);
            }
            if (
              text.includes(
                "insert into public.agent_outbox_caller_setup_requests"
              )
            ) {
              statements.push("setup insert");
              return queryResult(onInsert());
            }
            statements.push(text.replace(/\s+caller_setup_request$/, ""));
            return queryResult([]);
          }
        )
      )
    );
  };
  return {
    runProductTransaction,
    statements,
    get transactions() {
      return transactions;
    }
  };
}

/**
 * Wraps the node:crypto entropy exports, including ESM named-import bindings,
 * for the callback and restores them afterward. Each wrapper records its name
 * in `calls` and then throws `fault` when it is the failing export, otherwise
 * delegates to the original.
 *
 * @template TResult
 * @param {Array<"randomBytes" | "randomInt">} failing
 * @param {Error} fault
 * @param {(calls: string[]) => Promise<TResult>} callback
 */
async function withEntropyFailure(failing, fault, callback) {
  const names = /** @type {const} */ (["randomBytes", "randomInt"]);
  const originals = names.map((name) => crypto[name]);
  /** @type {string[]} */
  const calls = [];
  for (const [index, name] of names.entries()) {
    const original = /** @type {(...args: unknown[]) => unknown} */ (
      originals[index]
    );
    crypto[name] = /** @type {never} */ (
      (/** @type {unknown[]} */ ...args) => {
        calls.push(name);
        if (failing.includes(name)) {
          throw fault;
        }
        return original(...args);
      }
    );
  }
  syncBuiltinESMExports();
  try {
    return await callback(calls);
  } finally {
    for (const [index, name] of names.entries()) {
      crypto[name] = /** @type {never} */ (originals[index]);
    }
    syncBuiltinESMExports();
  }
}

/**
 * Captures console.error output as parsed JSON records during the callback
 * and restores console.error even if the callback throws.
 *
 * @param {() => Promise<unknown>} callback
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function captureErrorLogs(callback) {
  const original = console.error;
  /** @type {Array<Record<string, unknown>>} */
  const lines = [];
  console.error = (line) => {
    lines.push(JSON.parse(String(line)));
  };
  try {
    await callback();
  } finally {
    console.error = original;
  }
  return lines;
}

test("device start rejects invalid body, base URL and client IP before generating codes", async () => {
  for (const operation of /** @type {const} */ ([
    "connect",
    "rotate",
    "revoke"
  ])) {
    const rejections = [
      {
        name: "body",
        env: VALID_ENV,
        ipAddress: "203.0.113.77",
        body: null,
        status: 422,
        message: MESSAGES[operation].validationFailed
      },
      {
        name: "base URL",
        env: { ...VALID_ENV, PUBLIC_APP_BASE_URL: undefined },
        ipAddress: "203.0.113.77",
        body: validBody(operation, "device"),
        status: 503,
        message: "Public app base URL configuration is unavailable."
      },
      {
        name: "client IP",
        env: VALID_ENV,
        ipAddress: null,
        body: validBody(operation, "device"),
        status: 503,
        message: `Trusted client IP is unavailable for caller ${operation} start.`
      }
    ];
    for (const rejection of rejections) {
      const transaction = scriptedTransaction(() => assert.fail("insert"));
      await withProcessEnv(rejection.env, () =>
        withEntropyFailure(
          ["randomBytes", "randomInt"],
          new Error("controlled entropy failure"),
          async (calls) => {
            const result = await START_HANDLERS[operation].device(
              startRequest(operation, "device", rejection.ipAddress),
              CONTEXT,
              rejection.body,
              { runProductTransaction: transaction.runProductTransaction }
            );

            const label = `${operation} ${rejection.name}`;
            assert.equal(result.ok, false, label);
            assert.equal(result.error.status, rejection.status, label);
            assert.equal(result.error.message, rejection.message, label);
            assert.deepEqual(calls, [], label);
            assert.equal(transaction.transactions, 0, label);
          }
        )
      );
    }
  }
});

test("valid device start generates the device code before the user code and propagates failures before opening a transaction", async () => {
  const cases = [
    { failing: "randomBytes", calls: ["randomBytes"] },
    { failing: "randomInt", calls: ["randomBytes", "randomInt"] }
  ];
  for (const operation of /** @type {const} */ ([
    "connect",
    "rotate",
    "revoke"
  ])) {
    for (const entropy of cases) {
      const fault = new Error("controlled entropy failure");
      const transaction = scriptedTransaction(() => assert.fail("insert"));
      await withProcessEnv(VALID_ENV, () =>
        withEntropyFailure(
          [/** @type {"randomBytes" | "randomInt"} */ (entropy.failing)],
          fault,
          async (calls) => {
            await assert.rejects(
              START_HANDLERS[operation].device(
                startRequest(operation, "device"),
                CONTEXT,
                validBody(operation, "device"),
                { runProductTransaction: transaction.runProductTransaction }
              ),
              (error) => error === fault
            );
            const label = `${operation} ${entropy.failing}`;
            assert.deepEqual(calls, entropy.calls, label);
            assert.equal(transaction.transactions, 0, label);
          }
        )
      );
    }
  }
});

test("device start reports code-hashing failures through the transaction wrapper after IP limiting", async () => {
  const savepointRecovery = [
    "ip limit",
    "savepoint",
    "rollback to savepoint",
    "release savepoint"
  ];
  const expectedStatements = {
    connect: ["ip limit"],
    rotate: savepointRecovery,
    revoke: savepointRecovery
  };

  for (const operation of /** @type {const} */ ([
    "connect",
    "rotate",
    "revoke"
  ])) {
    const transaction = scriptedTransaction(() => assert.fail("insert"));
    /** @type {unknown} */
    let result;
    const logs = await withProcessEnv(
      { ...VALID_ENV, CALLER_KEY_HASH_SECRET: undefined },
      () =>
        captureErrorLogs(async () => {
          result = await START_HANDLERS[operation].device(
            startRequest(operation, "device"),
            CONTEXT,
            validBody(operation, "device"),
            { runProductTransaction: transaction.runProductTransaction }
          );
        })
    );

    assert.deepEqual(result, {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: MESSAGES[operation].temporarilyUnavailable,
        errorId: CONTEXT.correlationId,
        reported: true
      }
    });
    assert.deepEqual(transaction.statements, expectedStatements[operation]);
    assert.deepEqual(
      logs.map((log) => [log.operation, log.error_name, log.error_id]),
      [
        [
          `caller_${operation}_device_start`,
          "MissingServerEnvironmentError",
          CONTEXT.correlationId
        ]
      ]
    );
  }
});

test("connect start inserts without a savepoint and reports the original insert failure", async () => {
  const failures = [
    {
      error: () => new TypeError("controlled insert failure"),
      name: "TypeError"
    },
    {
      error: () =>
        Object.assign(new Error("foreign key violation"), { code: "23503" }),
      name: "Error",
      code: "23503"
    }
  ];
  for (const flow of /** @type {const} */ (["browser", "device"])) {
    for (const failure of failures) {
      const transaction = scriptedTransaction(() => {
        throw failure.error();
      });
      /** @type {unknown} */
      let result;
      const logs = await withProcessEnv(VALID_ENV, () =>
        captureErrorLogs(async () => {
          result = await START_HANDLERS.connect[flow](
            startRequest("connect", flow),
            CONTEXT,
            validBody("connect", flow),
            { runProductTransaction: transaction.runProductTransaction }
          );
        })
      );

      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 503,
          code: "temporary_unavailable",
          message: MESSAGES.connect.temporarilyUnavailable,
          errorId: CONTEXT.correlationId,
          reported: true
        }
      });
      assert.deepEqual(transaction.statements, ["ip limit", "setup insert"]);
      assert.deepEqual(
        logs.map((log) => [log.operation, log.error_name, log.error_code]),
        [[`caller_connect_${flow}_start`, failure.name, failure.code]]
      );
    }
  }
});

test("rotate and revoke start recover from an unknown target caller inside a savepoint", async () => {
  for (const operation of /** @type {const} */ (["rotate", "revoke"])) {
    for (const flow of /** @type {const} */ (["browser", "device"])) {
      const transaction = scriptedTransaction(() => {
        throw Object.assign(new Error("foreign key violation"), {
          code: "23503"
        });
      });
      const result = await withProcessEnv(VALID_ENV, async () =>
        START_HANDLERS[operation][flow](
          startRequest(operation, flow),
          CONTEXT,
          validBody(operation, flow),
          { runProductTransaction: transaction.runProductTransaction }
        )
      );

      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 400,
          code: "invalid_request",
          message: `Caller ${operation} target was not found.`
        }
      });
      assert.deepEqual(transaction.statements, [
        "ip limit",
        "savepoint",
        "setup insert",
        "rollback to savepoint",
        "release savepoint"
      ]);
      assert.equal(transaction.transactions, 1);
    }
  }
});

test("rotate and revoke start rethrow other insert failures to the transaction wrapper", async () => {
  for (const operation of /** @type {const} */ (["rotate", "revoke"])) {
    const transaction = scriptedTransaction(() => {
      throw new TypeError("controlled insert failure");
    });
    /** @type {unknown} */
    let result;
    const logs = await withProcessEnv(VALID_ENV, () =>
      captureErrorLogs(async () => {
        result = await START_HANDLERS[operation].browser(
          startRequest(operation, "browser"),
          CONTEXT,
          validBody(operation, "browser"),
          { runProductTransaction: transaction.runProductTransaction }
        );
      })
    );

    assert.equal(
      /** @type {{ error: { status: number } }} */ (result).error.status,
      503
    );
    assert.deepEqual(
      logs.map((log) => [log.operation, log.error_name]),
      [[`caller_${operation}_browser_start`, "TypeError"]]
    );
  }
});

test("browser start success returns the setup row's approval URL", async () => {
  for (const operation of /** @type {const} */ ([
    "connect",
    "rotate",
    "revoke"
  ])) {
    const transaction = scriptedTransaction(() => [
      { setup_request_id: SETUP_REQUEST_ID }
    ]);
    const result = await withProcessEnv(VALID_ENV, () =>
      START_HANDLERS[operation].browser(
        startRequest(operation, "browser"),
        CONTEXT,
        validBody(operation, "browser"),
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: transaction.runProductTransaction
        }
      )
    );

    assert.deepEqual(result, {
      ok: true,
      data: {
        approval_url: `https://app.agent-outbox.dev/caller/${operation}/approve?setup_request_id=${SETUP_REQUEST_ID}`,
        setup_request_id: SETUP_REQUEST_ID,
        expires_at: "2026-07-02T00:10:00.000Z"
      }
    });
    assert.deepEqual(
      transaction.statements,
      operation === "connect"
        ? ["ip limit", "setup insert"]
        : ["ip limit", "savepoint", "setup insert", "release savepoint"]
    );
  }
});

test("setup start transaction-open failures report the exact unscoped log fields", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  for (const operation of /** @type {const} */ ([
    "connect",
    "rotate",
    "revoke"
  ])) {
    for (const flow of /** @type {const} */ (["browser", "device"])) {
      let calls = 0;
      log.mock.resetCalls();
      await withProcessEnv(
        {
          ...VALID_ENV,
          APP_ENV: undefined,
          SENTRY_RELEASE: undefined,
          GITHUB_SHA: undefined
        },
        async () => {
          assert.deepEqual(
            await START_HANDLERS[operation][flow](
              startRequest(operation, flow),
              CONTEXT,
              validBody(operation, flow),
              {
                runProductTransaction: async () => {
                  calls += 1;
                  throw new Error("injected open failure");
                }
              }
            ),
            {
              ok: false,
              error: {
                status: 503,
                code: "temporary_unavailable",
                message: MESSAGES[operation].temporarilyUnavailable,
                errorId: CONTEXT.correlationId,
                reported: true
              }
            }
          );
        }
      );
      assert.equal(calls, 1);
      assert.deepEqual(
        log.mock.calls.map(({ arguments: args }) =>
          args.map((line) => JSON.parse(line))
        ),
        [
          [
            {
              environment: null,
              release: null,
              surface: "api",
              status_code: 503,
              operation: `caller_${operation}_${flow}_start`,
              message:
                operation === "connect"
                  ? "Caller connect request failed unexpectedly."
                  : "Caller credential operation failed unexpectedly.",
              request_id: CONTEXT.requestId,
              level: "error",
              error_id: CONTEXT.correlationId,
              error_name: "Error",
              sentry_captured: false
            }
          ]
        ]
      );
    }
  }
});
