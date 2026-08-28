import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceIpConnectDevicePollLimit,
  enforceIpConnectExchangeLimit,
  enforceIpConnectStartLimit
} from "../src/server/caller-api-limits.ts";
import { authenticateCallerApiRequest } from "../src/server/caller-api-auth.ts";
import {
  generateCallerApiKeyMaterial,
  parseCallerApiKey
} from "../src/server/caller-auth.ts";
import {
  approveConnectBrowserSetupRequest,
  approveConnectDeviceSetupRequest,
  callerSetupCodeDigest,
  denyConnectSetupRequest,
  exchangeApprovedConnectSetupRequest,
  getConnectBrowserApprovalPreview,
  getConnectDeviceApprovalPreview,
  getConnectTerminalSetupState,
  handleConnectAbortRequest,
  handleConnectActivateRequest,
  handleConnectBrowserStartRequest,
  handleConnectDeviceStartRequest,
  handleConnectDevicePollRequest,
  handleConnectExchangeRequest
} from "../src/server/caller-connect.ts";

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const CALLER_ID = "00000000-0000-4000-8000-000000000003";
const CONNECT_TEST_IP = "203.0.113.44";
const SETUP_REQUEST_ID = "10000000-0000-4000-8000-000000000301";
const PENDING_CREDENTIAL_ID = "20000000-0000-4000-8000-000000000402";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").ProductTransactionContext} ProductTransactionContext
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

/**
 * @template TResult
 * @param {Record<string, string | undefined>} values
 * @param {() => TResult | Promise<TResult>} callback
 * @returns {Promise<TResult>}
 */
async function withProcessEnv(values, callback) {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]])
  );

  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * @param {(statement: import("../src/server/database.ts").TransactionContextStatement, callNumber: number) => import("pg").QueryResultRow[]} resolver
 */
function fakeQuery(resolver) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /**
   * @param {TransactionContextStatement} statement
   * @returns {Promise<import("pg").QueryResult<import("pg").QueryResultRow>>}
   */
  const query = async (statement) => {
    calls.push(statement);
    const rows = resolver(statement, calls.length);
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  };
  const typed = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typed.calls = calls;
  return typed;
}

/**
 * @param {MockProductTransactionQuery[]} queries
 * @returns {{ runProductTransaction: typeof import("../src/server/database.ts").runProductTransaction, contexts: ProductTransactionContext[] }}
 */
function fakeTransactionRunner(queries) {
  const pendingQueries = [...queries];
  /** @type {ProductTransactionContext[]} */
  const contexts = [];
  /** @type {typeof import("../src/server/database.ts").runProductTransaction} */
  const runProductTransaction = async (
    _connectionString,
    context,
    callback
  ) => {
    contexts.push(context);
    const query = pendingQueries.shift();
    if (!query) {
      assert.fail("unexpected product transaction");
    }
    return await callback(query);
  };

  return { runProductTransaction, contexts };
}

/**
 * @param {string} path
 * @param {RequestInit & { headers?: Record<string, string> }} [init]
 */
function connectRequest(path, init = {}) {
  return new Request(`https://app.agent-outbox.dev${path}`, {
    ...init,
    headers: {
      "cf-connecting-ip": CONNECT_TEST_IP,
      ...(init.headers ?? {})
    }
  });
}

/**
 * Fake control-plane + caller transaction pair for a live connect-pending
 * credential, mirroring the rotate two-phase harness. The control transaction
 * resolves the bearer to an account/caller; the caller transaction locks and
 * mutates the pending credential.
 *
 * @param {import("../src/server/caller-auth.ts").DisplayOnceCallerApiKeyMaterial} material
 * @param {{ expiresAt?: string, pendingStatus?: string, pendingSecretDigest?: string }} [options]
 */
function pendingConnectRunner(material, options = {}) {
  const expiresAt = options.expiresAt ?? "2026-07-02T00:10:00.000Z";
  // Overrides that apply only to the locked pending row returned inside the
  // caller transaction, so a test can diverge that row from the (valid)
  // control-plane lookup to exercise the product-side state/secret guards.
  const pendingStatus = options.pendingStatus ?? "pending_activation";
  const pendingSecretDigest =
    options.pendingSecretDigest ?? material.secretDigest;
  const controlQuery = fakeQuery((_statement, callNumber) => {
    if (callNumber === 1) {
      return [{ used_units: "1" }];
    }
    return [
      {
        account_id: ACCOUNT_ID,
        caller_id: CALLER_ID,
        key_id: material.keyId,
        key_prefix: material.keyPrefix,
        key_last_four: material.keyLastCharacters,
        secret_hmac_sha256: material.secretDigest,
        status: "pending_activation",
        revoked_at: null,
        expires_at: expiresAt
      }
    ];
  });
  const callerQuery = fakeQuery((_statement, callNumber) => {
    if (callNumber === 1) {
      return [
        {
          caller_credential_id: PENDING_CREDENTIAL_ID,
          key_id: material.keyId,
          secret_hmac_sha256: pendingSecretDigest,
          status: pendingStatus,
          expires_at: expiresAt,
          revoked_at: null,
          account_id: ACCOUNT_ID,
          caller_id: CALLER_ID
        }
      ];
    }
    return [];
  });

  return {
    controlQuery,
    callerQuery,
    runner: fakeTransactionRunner([controlQuery, callerQuery])
  };
}

test("browser connect start returns approval metadata and inserts the setup request after the per-IP limit", async () => {
  await withProcessEnv(
    {
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000101";
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 2) {
          return [{ setup_request_id: setupRequestId }];
        }
        return [];
      });
      const runner = fakeTransactionRunner([query]);

      const result = await handleConnectBrowserStartRequest(
        connectRequest("/api/caller/connect/browser/start"),
        { requestId: "req-browser-start", correlationId: "corr-browser-start" },
        {
          local_caller_name: "steward-email",
          display_name: "Steward Email",
          callback_url: "http://127.0.0.1:49152/callback"
        },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.deepEqual(result, {
        ok: true,
        data: {
          approval_url:
            "https://app.agent-outbox.dev/caller/connect/approve?setup_request_id=10000000-0000-4000-8000-000000000101",
          setup_request_id: setupRequestId,
          expires_at: "2026-07-02T00:10:00.000Z"
        }
      });
      assert.equal(runner.contexts.length, 1);
      assert.equal(runner.contexts[0]?.authSurface, "control_plane");
      assert.deepEqual(query.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_start_requests_per_ip_per_minute"
      ]);
      assert.match(query.calls[0].sql, /agent_outbox_ip_quota_windows/);

      assert.match(
        query.calls[1].sql,
        /insert into public\.agent_outbox_caller_setup_requests/
      );
      assert.match(query.calls[1].sql, /values \('connect', 'browser'/);
      assert.deepEqual(query.calls[1].values, [
        "steward-email",
        "Steward Email",
        "http://127.0.0.1:49152/callback",
        "2026-07-02T00:10:00.000Z",
        5
      ]);
    }
  );
});

test("device connect start returns device metadata and stores only hashed device and user codes", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [{ used_units: "1" }];
        }
        return [];
      });
      const runner = fakeTransactionRunner([query]);

      const result = await handleConnectDeviceStartRequest(
        connectRequest("/api/caller/connect/device/start"),
        { requestId: "req-device-start", correlationId: "corr-device-start" },
        {
          local_caller_name: "steward-email",
          display_name: "Steward Email"
        },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.equal(result.ok, true);
      if (!result.ok) {
        assert.fail("expected device start success");
      }
      assert.match(result.data.device_code, /^dev_[A-Za-z0-9_-]+$/);
      assert.match(result.data.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.deepEqual(
        {
          verification_uri: result.data.verification_uri,
          verification_uri_complete: result.data.verification_uri_complete,
          expires_at: result.data.expires_at,
          poll_interval_seconds: result.data.poll_interval_seconds
        },
        {
          verification_uri:
            "https://app.agent-outbox.dev/caller/connect/device",
          verification_uri_complete: `https://app.agent-outbox.dev/caller/connect/device?user_code=${encodeURIComponent(
            result.data.user_code
          )}`,
          expires_at: "2026-07-02T00:10:00.000Z",
          poll_interval_seconds: 5
        }
      );
      assert.equal(runner.contexts.length, 1);
      assert.equal(runner.contexts[0]?.authSurface, "control_plane");
      assert.deepEqual(query.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_start_requests_per_ip_per_minute"
      ]);
      assert.match(query.calls[0].sql, /agent_outbox_ip_quota_windows/);

      assert.match(
        query.calls[1].sql,
        /insert into public\.agent_outbox_caller_setup_requests/
      );
      assert.match(query.calls[1].sql, /values \('connect', 'device'/);
      assert.deepEqual(query.calls[1].values?.slice(0, 2), [
        "steward-email",
        "Steward Email"
      ]);
      assert.equal(
        query.calls[1].values?.[2],
        callerSetupCodeDigest(result.data.device_code)
      );
      assert.equal(
        query.calls[1].values?.[3],
        callerSetupCodeDigest(result.data.user_code.replace(/[\s-]+/g, ""))
      );
      assert.match(String(query.calls[1].values?.[2]), /^[a-f0-9]{64}$/);
      assert.match(String(query.calls[1].values?.[3]), /^[a-f0-9]{64}$/);
      assert.deepEqual(query.calls[1].values?.slice(4), [
        "2026-07-02T00:10:00.000Z",
        5
      ]);

      const serializedCalls = JSON.stringify(query.calls);
      assert.equal(serializedCalls.includes(result.data.device_code), false);
      assert.equal(serializedCalls.includes(result.data.user_code), false);
    }
  );
});

test("connect start per-IP limiting blocks before setup insert", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const cases = [
        {
          name: "browser",
          handler: handleConnectBrowserStartRequest,
          path: "/api/caller/connect/browser/start",
          body: {
            local_caller_name: "steward-email",
            display_name: "Steward Email",
            callback_url: "http://127.0.0.1:49152/callback"
          }
        },
        {
          name: "device",
          handler: handleConnectDeviceStartRequest,
          path: "/api/caller/connect/device/start",
          body: {
            local_caller_name: "steward-email",
            display_name: "Steward Email"
          }
        }
      ];

      for (const testCase of cases) {
        const query = fakeQuery(() => [{ used_units: "31" }]);
        const runner = fakeTransactionRunner([query]);

        const result = await testCase.handler(
          connectRequest(testCase.path),
          {
            requestId: `req-${testCase.name}-start-limit`,
            correlationId: `corr-${testCase.name}-start-limit`
          },
          testCase.body,
          {
            now: new Date("2026-07-02T00:00:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.equal(result.ok, false, testCase.name);
        if (result.ok) {
          assert.fail(`expected ${testCase.name} start rate limit`);
        }
        assert.equal(result.error.status, 429, testCase.name);
        assert.equal(result.error.code, "rate_limit_exceeded", testCase.name);
        assert.ok(result.error.limit && "limitName" in result.error.limit);
        assert.equal(
          result.error.limit.limitName,
          "caller_connect_start_requests_per_ip_per_minute",
          testCase.name
        );
        assert.equal(query.calls.length, 1, testCase.name);
        assert.deepEqual(query.calls[0].values?.slice(0, 2), [
          CONNECT_TEST_IP,
          "caller_connect_start_requests_per_ip_per_minute"
        ]);
        assert.doesNotMatch(
          query.calls[0].sql,
          /agent_outbox_caller_setup_requests/,
          testCase.name
        );
      }
    }
  );
});

test("connect start rejects X-Forwarded-For-only requests before transactions", async () => {
  await withProcessEnv(
    {
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const runner = fakeTransactionRunner([]);
      const result = await handleConnectBrowserStartRequest(
        connectRequest("/api/caller/connect/browser/start", {
          headers: {
            "cf-connecting-ip": "",
            "x-forwarded-for": "198.51.100.44"
          }
        }),
        {
          requestId: "req-browser-start-untrusted-ip",
          correlationId: "corr-browser-start-untrusted-ip"
        },
        {
          local_caller_name: "steward-email",
          display_name: "Steward Email",
          callback_url: "http://127.0.0.1:49152/callback"
        },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected X-Forwarded-For-only connect start to fail");
      }
      assert.equal(result.error.status, 503);
      assert.equal(result.error.code, "temporary_unavailable");
      assert.equal(runner.contexts.length, 0);
    }
  );
});

test("browser approval preview exposes only pending setup metadata", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000031";
      const query = fakeQuery(() => [
        {
          setup_request_id: setupRequestId,
          operation: "connect",
          flow: "browser",
          status: "pending",
          local_caller_name: "steward-email",
          display_name: "Steward Email",
          callback_url: "http://127.0.0.1:49152/callback",
          expires_at: "2026-07-02T00:10:00.000Z"
        }
      ]);

      const result = await getConnectBrowserApprovalPreview(query, {
        setupRequestId,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.deepEqual(result, {
        ok: true,
        data: {
          setup_request_id: setupRequestId,
          operation: "connect",
          flow: "browser",
          status: "pending",
          local_caller_name: "steward-email",
          display_name: "Steward Email",
          callback_url: "http://127.0.0.1:49152/callback",
          expires_at: "2026-07-02T00:10:00.000Z"
        }
      });
      assert.equal(query.calls.length, 1);
      assert.doesNotMatch(query.calls[0].sql, /setup_code_hash/);
    }
  );
});

test("terminal setup state is scoped to account and persisted status", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000041";
      const query = fakeQuery(() => [
        {
          setup_request_id: setupRequestId,
          operation: "connect",
          flow: "device",
          status: "approved",
          local_caller_name: "steward-email",
          display_name: "Steward Email Setup",
          caller_id: CALLER_ID,
          caller_slug: "steward-email",
          caller_display_name: "Steward Email"
        }
      ]);

      const result = await getConnectTerminalSetupState(query, {
        setupRequestId,
        accountId: ACCOUNT_ID,
        statuses: ["approved", "exchanged"]
      });

      assert.deepEqual(result, {
        ok: true,
        data: {
          setup_request_id: setupRequestId,
          operation: "connect",
          flow: "device",
          status: "approved",
          local_caller_name: "steward-email",
          display_name: "Steward Email Setup",
          caller: {
            caller_id: CALLER_ID,
            caller_slug: "steward-email",
            display_name: "Steward Email"
          }
        }
      });
      assert.match(query.calls[0].sql, /setup\.account_id = \$2/);
      assert.match(query.calls[0].sql, /setup\.status in \(\$3, \$4\)/);
      assert.deepEqual(query.calls[0].values, [
        setupRequestId,
        ACCOUNT_ID,
        "approved",
        "exchanged"
      ]);
    }
  );
});

test("device approval preview normalizes the user code and expires stale setup requests", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000032";
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              operation: "connect",
              flow: "device",
              status: "pending",
              local_caller_name: "steward-email",
              display_name: "Steward Email",
              callback_url: null,
              expires_at: "2026-07-01T23:59:00.000Z"
            }
          ];
        }
        return [];
      });

      const result = await getConnectDeviceApprovalPreview(query, {
        userCode: "abcd-2345",
        accountId: ACCOUNT_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected expired preview to fail");
      }
      assert.deepEqual(query.calls[0].values, [
        callerSetupCodeDigest("ABCD2345")
      ]);
      assert.equal(result.error.code, "invalid_request");
      assert.match(query.calls[1].sql, /status = 'expired'/);
      assert.deepEqual(query.calls[1].values, [setupRequestId]);
    }
  );
});

test("device approval preview treats an exchanged request from the same account as success", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000033";
      const query = fakeQuery(() => [
        {
          setup_request_id: setupRequestId,
          operation: "connect",
          flow: "device",
          status: "exchanged",
          local_caller_name: "steward-email",
          display_name: "Steward Email",
          callback_url: null,
          expires_at: "2026-07-02T00:10:00.000Z",
          account_id: ACCOUNT_ID,
          caller_id: CALLER_ID,
          caller_slug: "steward-email",
          caller_display_name: "Steward Email"
        }
      ]);

      const result = await getConnectDeviceApprovalPreview(query, {
        userCode: "abcd-2345",
        accountId: ACCOUNT_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        assert.fail("expected exchanged preview to remain successful");
      }
      assert.equal(result.data.setup_request_id, setupRequestId);
      assert.equal(result.data.status, "exchanged");
      assert.equal(query.calls.length, 1);
      assert.match(
        query.calls[0].sql,
        /status in \('pending', 'approved', 'exchanged'\)/
      );
      assert.match(query.calls[0].sql, /for update of setup/);
    }
  );
});

test("device approval preview does not expose another account's completed request", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const query = fakeQuery(() => [
        {
          setup_request_id: "10000000-0000-4000-8000-000000000034",
          operation: "connect",
          flow: "device",
          status: "approved",
          local_caller_name: "steward-email",
          display_name: "Steward Email",
          callback_url: null,
          expires_at: "2026-07-02T00:10:00.000Z",
          account_id: "00000000-0000-4000-8000-000000000099",
          caller_id: CALLER_ID,
          caller_slug: "steward-email",
          caller_display_name: "Steward Email"
        }
      ]);

      const result = await getConnectDeviceApprovalPreview(query, {
        userCode: "abcd-2345",
        accountId: ACCOUNT_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected cross-account preview to fail");
      }
      assert.equal(result.error.code, "invalid_request");
      assert.equal(query.calls.length, 1);
    }
  );
});

test("denying a setup request binds the terminal state to the cancelling account", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000042";
      const query = fakeQuery(() => [
        {
          setup_request_id: setupRequestId
        }
      ]);

      const result = await denyConnectSetupRequest(query, {
        setupRequestId,
        accountId: ACCOUNT_ID
      });

      assert.deepEqual(result, {
        ok: true,
        data: {
          setup_request_id: setupRequestId,
          denied: true
        }
      });
      assert.match(query.calls[0].sql, /account_id = \$2/);
      assert.match(query.calls[0].sql, /status = 'denied'/);
      // The connect deny path must only ever target connect rows, so it can
      // never deny a pending rotate/revoke setup request submitted to it.
      assert.match(query.calls[0].sql, /operation = 'connect'/);
      assert.deepEqual(query.calls[0].values, [setupRequestId, ACCOUNT_ID]);
    }
  );
});

test("connect denial refuses a setup request that is not a pending connect row", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      // A rotate/revoke setup request id submitted to the connect deny route
      // matches no connect row, so the guarded UPDATE returns zero rows.
      const query = fakeQuery(() => []);

      const result = await denyConnectSetupRequest(query, {
        setupRequestId: "10000000-0000-4000-8000-000000000042",
        accountId: ACCOUNT_ID
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected connect denial of a non-connect row to fail");
      }
      assert.equal(result.error.code, "not_found");
    }
  );
});

test("browser approval binds the setup request to the approving account and caller", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000001";
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              flow: "browser",
              status: "pending",
              local_caller_name: "steward-email",
              display_name: "Steward Email",
              callback_url: "http://127.0.0.1:49152/callback",
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        if (callNumber === 2) {
          return [{ tier: "hosted_free" }];
        }
        if (callNumber === 3) {
          return [];
        }
        if (callNumber === 4) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 5) {
          return [];
        }
        if (callNumber === 6) {
          return [
            {
              caller_id: CALLER_ID,
              caller_slug: "steward-email",
              display_name: "Steward Email"
            }
          ];
        }
        return [];
      });

      const result = await approveConnectBrowserSetupRequest(query, {
        setupRequestId,
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        assert.fail("expected browser approval success");
      }
      assert.equal(result.data.callback_url, "http://127.0.0.1:49152/callback");
      assert.match(result.data.setup_code, /^setup_[A-Za-z0-9_-]+$/);
      assert.deepEqual(result.data.caller, {
        caller_id: CALLER_ID,
        caller_slug: "steward-email",
        display_name: "Steward Email"
      });

      assert.match(
        query.calls[1].sql,
        /select tier from public\.agent_outbox_accounts/
      );
      assert.match(query.calls[2].sql, /agent_outbox_account_limit_blocks/);
      assert.match(query.calls[3].sql, /agent_outbox_account_quota_windows/);
      assert.deepEqual(query.calls[3].values?.slice(0, 2), [
        ACCOUNT_ID,
        "caller_connect_approvals_per_account_per_minute"
      ]);
      assert.match(query.calls[4].sql, /from public\.agent_outbox_callers/);
      assert.deepEqual(query.calls[4].values, [ACCOUNT_ID, "steward-email"]);
      assert.match(
        query.calls[5].sql,
        /insert into public\.agent_outbox_callers/
      );
      assert.deepEqual(query.calls[5].values, [
        ACCOUNT_ID,
        "Steward Email",
        "steward-email"
      ]);
      assert.match(
        query.calls[6].sql,
        /update public\.agent_outbox_caller_setup_requests/
      );
      assert.deepEqual(query.calls[6].values?.slice(0, 4), [
        setupRequestId,
        ACCOUNT_ID,
        CALLER_ID,
        USER_ID
      ]);
      assert.match(String(query.calls[6].values?.[4]), /^[a-f0-9]{64}$/);
      assert.doesNotMatch(
        JSON.stringify(query.calls),
        new RegExp(result.data.setup_code)
      );
    }
  );
});

test("device approval binds the account and moves the request pending -> approved", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000009";
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              flow: "device",
              status: "pending",
              local_caller_name: "steward-email",
              display_name: "Steward Email",
              callback_url: null,
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        if (callNumber === 2) {
          return [{ tier: "hosted_free" }];
        }
        if (callNumber === 3) {
          return [];
        }
        if (callNumber === 4) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 5) {
          return [];
        }
        if (callNumber === 6) {
          return [
            {
              caller_id: CALLER_ID,
              caller_slug: "steward-email",
              display_name: "Steward Email"
            }
          ];
        }
        return [];
      });

      const result = await approveConnectDeviceSetupRequest(query, {
        userCode: "abcd-2345",
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        assert.fail("expected device approval success");
      }
      assert.deepEqual(result.data.caller, {
        caller_id: CALLER_ID,
        caller_slug: "steward-email",
        display_name: "Steward Email"
      });

      // The request is looked up by the hashed, normalized user code, never
      // the plaintext code the human typed.
      assert.match(String(query.calls[0].values?.[0]), /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(query.calls), /abcd-2345/i);
      assert.match(
        query.calls[0].sql,
        /status in \('pending', 'approved', 'exchanged'\)/
      );
      assert.match(query.calls[0].sql, /expires_at > now\(\)/);
      assert.match(
        query.calls[0].sql,
        /order by setup\.expires_at desc, setup\.created_at desc/
      );
      assert.match(query.calls[0].sql, /limit 1/);

      // Approval binds account/caller/approver and transitions to approved.
      assert.match(
        query.calls[6].sql,
        /update public\.agent_outbox_caller_setup_requests/
      );
      assert.match(query.calls[6].sql, /status = 'approved'/);
      assert.deepEqual(query.calls[6].values, [
        setupRequestId,
        ACCOUNT_ID,
        CALLER_ID,
        USER_ID
      ]);
    }
  );
});

test("repeated device approval is idempotent before and after the CLI exchanges the code", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000010";
      for (const status of ["approved", "exchanged"]) {
        const query = fakeQuery(() => [
          {
            setup_request_id: setupRequestId,
            operation: "connect",
            flow: "device",
            status,
            local_caller_name: "steward-email",
            display_name: "Steward Email",
            callback_url: null,
            expires_at: "2026-07-02T00:10:00.000Z",
            account_id: ACCOUNT_ID,
            caller_id: CALLER_ID,
            caller_slug: "steward-email",
            caller_display_name: "Steward Email"
          }
        ]);

        const result = await approveConnectDeviceSetupRequest(query, {
          userCode: "abcd-2345",
          accountId: ACCOUNT_ID,
          userId: USER_ID,
          now: new Date("2026-07-02T00:00:00.000Z")
        });

        assert.deepEqual(result, {
          ok: true,
          data: {
            setup_request_id: setupRequestId,
            caller: {
              caller_id: CALLER_ID,
              caller_slug: "steward-email",
              display_name: "Steward Email"
            }
          }
        });
        assert.equal(query.calls.length, 1);
        assert.equal(
          query.calls.some((call) => /^\s*(insert|update)\b/i.test(call.sql)),
          false
        );
      }
    }
  );
});

test("repeated device approval cannot cross account boundaries", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const query = fakeQuery(() => [
        {
          setup_request_id: "10000000-0000-4000-8000-000000000011",
          operation: "connect",
          flow: "device",
          status: "approved",
          local_caller_name: "steward-email",
          display_name: "Steward Email",
          callback_url: null,
          expires_at: "2026-07-02T00:10:00.000Z",
          account_id: "00000000-0000-4000-8000-000000000099",
          caller_id: CALLER_ID,
          caller_slug: "steward-email",
          caller_display_name: "Steward Email"
        }
      ]);

      const result = await approveConnectDeviceSetupRequest(query, {
        userCode: "abcd-2345",
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected cross-account repeat approval to fail");
      }
      assert.equal(result.error.code, "invalid_request");
      assert.equal(query.calls.length, 1);
    }
  );
});

test("browser approval rejects a duplicate caller name before caller creation", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000011";
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              flow: "browser",
              status: "pending",
              local_caller_name: "steward-email",
              display_name: "Steward Email",
              callback_url: "http://127.0.0.1:49152/callback",
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        if (callNumber === 2) {
          return [{ tier: "hosted_free" }];
        }
        if (callNumber === 3) {
          return [];
        }
        if (callNumber === 4) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 5) {
          return [
            {
              caller_id: "00000000-0000-4000-8000-000000000099"
            }
          ];
        }
        return [];
      });

      const result = await approveConnectBrowserSetupRequest(query, {
        setupRequestId,
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected duplicate caller rejection");
      }
      assert.equal(result.error.status, 409);
      assert.equal(result.error.code, "caller_already_exists");
      assert.equal(
        result.error.message,
        "A caller with this name already exists for this account. Use caller rotate or choose a different name."
      );
      assert.deepEqual(result.error.fields, [
        {
          path: "local_caller_name",
          code: "duplicate",
          message: "A caller with this name already exists for this account."
        }
      ]);
      assert.match(query.calls[4].sql, /from public\.agent_outbox_callers/);
      assert.deepEqual(query.calls[4].values, [ACCOUNT_ID, "steward-email"]);
      assert.equal(
        query.calls.some((call) =>
          /insert into public\.agent_outbox_callers/.test(call.sql)
        ),
        false
      );
      assert.equal(
        query.calls.some((call) =>
          /update public\.agent_outbox_caller_setup_requests/.test(call.sql)
        ),
        false
      );
    }
  );
});

test("device approval rejects a duplicate caller name before caller creation", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000012";
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              flow: "device",
              status: "pending",
              local_caller_name: "steward-email",
              display_name: "Steward Email",
              callback_url: null,
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        if (callNumber === 2) {
          return [{ tier: "hosted_free" }];
        }
        if (callNumber === 3) {
          return [];
        }
        if (callNumber === 4) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 5) {
          return [
            {
              caller_id: "00000000-0000-4000-8000-000000000099"
            }
          ];
        }
        return [];
      });

      const result = await approveConnectDeviceSetupRequest(query, {
        userCode: "abcd-2345",
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected duplicate caller rejection");
      }
      assert.equal(result.error.status, 409);
      assert.equal(result.error.code, "caller_already_exists");
      assert.match(query.calls[4].sql, /from public\.agent_outbox_callers/);
      assert.deepEqual(query.calls[4].values, [ACCOUNT_ID, "steward-email"]);
      assert.equal(
        query.calls.some((call) =>
          /insert into public\.agent_outbox_callers/.test(call.sql)
        ),
        false
      );
      assert.equal(
        query.calls.some((call) =>
          /update public\.agent_outbox_caller_setup_requests/.test(call.sql)
        ),
        false
      );
    }
  );
});

test("account-scoped connect approval abuse control blocks before caller creation", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000004";
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              flow: "browser",
              status: "pending",
              local_caller_name: "steward-email",
              display_name: "Steward Email",
              callback_url: "http://127.0.0.1:49152/callback",
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        if (callNumber === 2) {
          return [{ tier: "hosted_free" }];
        }
        if (callNumber === 3) {
          return [];
        }
        if (callNumber === 4) {
          return [{ used_units: "31" }];
        }
        return [];
      });

      const result = await approveConnectBrowserSetupRequest(query, {
        setupRequestId,
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected account-scoped approval limit");
      }
      assert.equal(result.error.status, 429);
      assert.equal(result.error.code, "rate_limit_exceeded");
      assert.ok(result.error.limit && "limit_name" in result.error.limit);
      assert.equal(
        result.error.limit.limit_name,
        "caller_connect_approvals_per_account_per_minute"
      );
      assert.match(query.calls[3].sql, /agent_outbox_account_quota_windows/);
      assert.match(query.calls[4].sql, /agent_outbox_account_limit_blocks/);
      assert.equal(
        query.calls.some((call) =>
          /insert into public\.agent_outbox_callers/.test(call.sql)
        ),
        false
      );
    }
  );
});

test("connect exchange mints only a pending credential without activating, revoking, or auditing", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000001";
      const query = fakeQuery((statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              status: "approved",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              approved_by_user_id: USER_ID,
              poll_interval_seconds: 5,
              expires_at: "2026-07-02T00:10:00.000Z",
              caller_slug: "steward-email",
              caller_display_name: "Steward Email",
              account_label: "Nick's Agent Outbox",
              account_tier: "hosted_free"
            }
          ];
        }
        if (callNumber === 2) {
          return [
            {
              key_id: String(statement.values?.[2]),
              key_prefix: String(statement.values?.[3]),
              key_last_four: String(statement.values?.[4]),
              created_at: "2026-07-02T00:00:00.000Z"
            }
          ];
        }
        return [];
      });

      const result = await exchangeApprovedConnectSetupRequest(
        query,
        { flow: "browser", codeHash: "a".repeat(64) },
        {
          requestId: "req-connect",
          now: new Date("2026-07-02T00:00:00.000Z")
        }
      );

      assert.equal(result.ok, true);
      if (!result.ok) {
        assert.fail("expected exchange success");
      }

      assert.match(
        result.data.credential.api_key,
        /^aob_live_[a-z2-7]+_[a-z2-7]+$/
      );
      assert.equal(
        result.data.credential.created_at,
        "2026-07-02T00:00:00.000Z"
      );
      // The display-once key is pending until the CLI confirms activation, so
      // the response advertises the short expiry the caller must beat.
      assert.equal(
        result.data.credential.expires_at,
        "2026-07-02T00:10:00.000Z"
      );
      // The CLI must thread setup_request_id into connect/activate|abort; it is
      // returned here because the device flow has no separate exchange step.
      assert.equal(result.data.setup_request_id, setupRequestId);
      assert.deepEqual(result.data.caller, {
        caller_id: CALLER_ID,
        caller_slug: "steward-email",
        display_name: "Steward Email"
      });
      assert.deepEqual(result.data.account, {
        account_id: ACCOUNT_ID,
        label: "Nick's Agent Outbox",
        effective_tier: "free"
      });

      const credentialInsert = query.calls[1];
      assert.match(
        credentialInsert.sql,
        /insert into public\.agent_outbox_caller_credentials/
      );
      // Exchange must store the credential as pending_activation (not active)
      // and link it to its setup request so activate/abort can find it.
      assert.match(credentialInsert.sql, /'pending_activation'/);
      assert.doesNotMatch(credentialInsert.sql, /'active'/);
      assert.doesNotMatch(credentialInsert.sql, /activated_at/);
      assert.deepEqual(credentialInsert.values?.slice(0, 2), [
        ACCOUNT_ID,
        CALLER_ID
      ]);
      assert.match(String(credentialInsert.values?.[5]), /^[a-f0-9]{64}$/);
      assert.equal(credentialInsert.values?.[6], "2026-07-02T00:10:00.000Z");
      assert.equal(credentialInsert.values?.[7], setupRequestId);
      assert.doesNotMatch(
        JSON.stringify(query.calls),
        new RegExp(result.data.credential.api_key)
      );
      assert.match(query.calls[2].sql, /set\s+status = 'exchanged'/m);
      // No caller_registered audit and no activate/revoke happen at exchange;
      // those are deferred to connect/activate.
      const exchangeSql = query.calls.map((call) => call.sql).join("\n");
      assert.doesNotMatch(exchangeSql, /caller_registered/);
      assert.doesNotMatch(exchangeSql, /status = 'active'/);
      assert.doesNotMatch(exchangeSql, /status = 'revoked'/);
      assert.equal(query.calls.length, 3);
    }
  );
});

test("device poll returns authorization_pending with retry metadata before approval", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const controlQuery = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 2) {
          return [
            {
              setup_request_id: "10000000-0000-4000-8000-000000000020",
              status: "pending",
              account_id: null,
              approved_by_user_id: null,
              poll_interval_seconds: 5,
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        return [];
      });
      const runner = fakeTransactionRunner([controlQuery]);

      const result = await handleConnectDevicePollRequest(
        connectRequest("/api/caller/connect/device/poll"),
        { requestId: "req-device-poll", correlationId: "corr-device-poll" },
        { device_code: "dev_pending" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 202,
          code: "authorization_pending",
          message: "Caller connect approval is pending.",
          retryAfterSeconds: 5
        }
      });
      assert.equal(runner.contexts.length, 1);
      assert.equal(runner.contexts[0]?.authSurface, "control_plane");
      assert.deepEqual(controlQuery.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_poll_requests_per_ip_per_minute"
      ]);
      assert.match(String(controlQuery.calls[1].values?.[0]), /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(controlQuery.calls), /dev_pending/);
    }
  );
});

test("approved device poll returns the display-once pending caller credential", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000021";
      const controlQuery = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 2) {
          return [
            {
              setup_request_id: setupRequestId,
              status: "approved",
              account_id: ACCOUNT_ID,
              approved_by_user_id: USER_ID,
              poll_interval_seconds: 5,
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        return [];
      });
      const humanQuery = fakeQuery((statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: setupRequestId,
              status: "approved",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              approved_by_user_id: USER_ID,
              poll_interval_seconds: 5,
              expires_at: "2026-07-02T00:10:00.000Z",
              caller_slug: "steward-email",
              caller_display_name: "Steward Email",
              account_label: "Nick's Agent Outbox",
              account_tier: "hosted_free"
            }
          ];
        }
        if (callNumber === 2) {
          return [
            {
              key_id: String(statement.values?.[2]),
              key_prefix: String(statement.values?.[3]),
              key_last_four: String(statement.values?.[4]),
              created_at: "2026-07-02T00:00:00.000Z"
            }
          ];
        }
        return [];
      });
      const runner = fakeTransactionRunner([controlQuery, humanQuery]);

      const result = await handleConnectDevicePollRequest(
        connectRequest("/api/caller/connect/device/poll"),
        { requestId: "req-device-poll", correlationId: "corr-device-poll" },
        { device_code: "dev_approved" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.equal(result.ok, true);
      if (!result.ok) {
        assert.fail("expected approved poll credential response");
      }
      assert.match(
        result.data.credential.api_key,
        /^aob_live_[a-z2-7]+_[a-z2-7]+$/
      );
      assert.equal(
        result.data.credential.created_at,
        "2026-07-02T00:00:00.000Z"
      );
      assert.equal(
        result.data.credential.expires_at,
        "2026-07-02T00:10:00.000Z"
      );
      // Device connect has no separate exchange call, so the poll response is
      // the CLI's only source of setup_request_id for activate/abort.
      assert.equal(result.data.setup_request_id, setupRequestId);
      assert.deepEqual(result.data.caller, {
        caller_id: CALLER_ID,
        caller_slug: "steward-email",
        display_name: "Steward Email"
      });
      assert.deepEqual(result.data.account, {
        account_id: ACCOUNT_ID,
        label: "Nick's Agent Outbox",
        effective_tier: "free"
      });
      // The device-poll credential is minted pending, exactly like exchange,
      // and never activated or revoked here.
      const deviceInsert = humanQuery.calls[1];
      assert.match(
        deviceInsert.sql,
        /insert into public\.agent_outbox_caller_credentials/
      );
      assert.match(deviceInsert.sql, /'pending_activation'/);
      assert.equal(deviceInsert.values?.[7], setupRequestId);
      const deviceSql = humanQuery.calls.map((call) => call.sql).join("\n");
      assert.doesNotMatch(deviceSql, /caller_registered/);
      assert.doesNotMatch(deviceSql, /status = 'active'/);
      assert.doesNotMatch(deviceSql, /status = 'revoked'/);
      assert.deepEqual(
        runner.contexts.map((context) => context.authSurface),
        ["control_plane", "human"]
      );
      assert.equal(runner.contexts[1]?.accountId, ACCOUNT_ID);
      assert.equal(runner.contexts[1]?.userId, USER_ID);
      assert.deepEqual(controlQuery.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_poll_requests_per_ip_per_minute"
      ]);
      assert.match(humanQuery.calls[0].sql, /setup\.flow = 'device'/);
      assert.equal(humanQuery.calls[0].values?.length, 1);
      assert.match(String(humanQuery.calls[0].values?.[0]), /^[a-f0-9]{64}$/);
      assert.doesNotMatch(
        JSON.stringify([...controlQuery.calls, ...humanQuery.calls]),
        new RegExp(result.data.credential.api_key)
      );
      assert.match(humanQuery.calls[2].sql, /set\s+status = 'exchanged'/m);
    }
  );
});

test("pending or denied setup-code exchange is rejected before credential minting", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      for (const status of ["pending", "denied"]) {
        const controlQuery = fakeQuery((_statement, callNumber) => {
          if (callNumber === 1) {
            return [{ used_units: "1" }];
          }
          if (callNumber === 2) {
            return [
              {
                setup_request_id: "10000000-0000-4000-8000-000000000022",
                status,
                account_id: status === "denied" ? ACCOUNT_ID : null,
                approved_by_user_id: null,
                poll_interval_seconds: 5,
                expires_at: "2026-07-02T00:10:00.000Z"
              }
            ];
          }
          return [];
        });
        const runner = fakeTransactionRunner([controlQuery]);

        const result = await handleConnectExchangeRequest(
          connectRequest("/api/caller/connect/exchange"),
          { requestId: "req-exchange", correlationId: "corr-exchange" },
          { setup_code: `setup_${status}` },
          {
            now: new Date("2026-07-02T00:00:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.deepEqual(
          result,
          {
            ok: false,
            error: {
              status: 400,
              code: "invalid_request",
              message: "Setup code is invalid or already used."
            }
          },
          status
        );
        assert.equal(runner.contexts.length, 1, status);
        assert.equal(runner.contexts[0]?.authSurface, "control_plane", status);
        assert.deepEqual(controlQuery.calls[0].values?.slice(0, 2), [
          CONNECT_TEST_IP,
          "caller_connect_exchange_requests_per_ip_per_minute"
        ]);
        assert.match(
          String(controlQuery.calls[1].values?.[0]),
          /^[a-f0-9]{64}$/
        );
        assert.equal(
          controlQuery.calls.some((call) =>
            /agent_outbox_caller_credentials/.test(call.sql)
          ),
          false,
          status
        );
      }
    }
  );
});

test("exchanged or expired connect codes cannot mint another credential", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      for (const status of ["exchanged", "approved"]) {
        const query = fakeQuery((_statement, callNumber) => {
          if (callNumber === 1) {
            return [
              {
                setup_request_id: "10000000-0000-4000-8000-000000000001",
                status,
                account_id: ACCOUNT_ID,
                caller_id: CALLER_ID,
                approved_by_user_id: USER_ID,
                poll_interval_seconds: 5,
                expires_at:
                  status === "approved"
                    ? "2026-07-01T23:59:00.000Z"
                    : "2026-07-02T00:10:00.000Z",
                caller_slug: "steward-email",
                caller_display_name: "Steward Email",
                account_label: "Nick's Agent Outbox",
                account_tier: "hosted_free"
              }
            ];
          }
          return [];
        });

        const result = await exchangeApprovedConnectSetupRequest(
          query,
          { flow: "browser", codeHash: "b".repeat(64) },
          {
            requestId: "req-connect",
            now: new Date("2026-07-02T00:00:00.000Z")
          }
        );

        assert.deepEqual(
          result,
          {
            ok: false,
            error: {
              status: 400,
              code: "invalid_request",
              message:
                status === "approved"
                  ? "Caller connect code is invalid or expired."
                  : "Caller connect code is invalid or already used."
            }
          },
          status
        );
        assert.equal(
          query.calls.some((call) =>
            /agent_outbox_caller_credentials/.test(call.sql)
          ),
          false,
          status
        );
      }
    }
  );
});

test("per-IP connect control-plane abuse controls return retry metadata from the DB window", async () => {
  const cases = [
    {
      enforce: enforceIpConnectStartLimit,
      limitName: "caller_connect_start_requests_per_ip_per_minute"
    },
    {
      enforce: enforceIpConnectDevicePollLimit,
      limitName: "caller_connect_poll_requests_per_ip_per_minute"
    },
    {
      enforce: enforceIpConnectExchangeLimit,
      limitName: "caller_connect_exchange_requests_per_ip_per_minute"
    }
  ];

  for (const { enforce, limitName } of cases) {
    const query = fakeQuery(() => [{ used_units: "31" }]);

    const result = await enforce(query, "203.0.113.9");

    assert.equal(result.ok, false, limitName);
    if (result.ok) {
      assert.fail(`expected ${limitName} rate limit`);
    }
    const limit =
      /** @type {import("../src/server/limits.ts").LimitErrorMetadata} */ (
        result.error.limit
      );
    assert.equal(result.error.status, 429, limitName);
    assert.equal(result.error.code, "rate_limit_exceeded", limitName);
    assert.equal(limit.limitName, limitName);
    assert.equal(limit.usedUnits, 31);
    assert.match(query.calls[0].sql, /agent_outbox_ip_quota_windows/);
    assert.match(
      query.calls[0].sql,
      /on conflict \(ip_address, metric, window_kind, window_start_utc\)/
    );
    assert.deepEqual(query.calls[0].values?.slice(0, 3), [
      "203.0.113.9",
      limitName,
      "minute"
    ]);
  }
});

test("device poll per-IP abuse control blocks before setup lookup", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const controlQuery = fakeQuery(() => [{ used_units: "31" }]);
      const runner = fakeTransactionRunner([controlQuery]);

      const result = await handleConnectDevicePollRequest(
        connectRequest("/api/caller/connect/device/poll"),
        { requestId: "req-device-poll", correlationId: "corr-device-poll" },
        { device_code: "dev_pending" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected device poll rate limit");
      }
      assert.equal(result.error.status, 429);
      assert.equal(result.error.code, "rate_limit_exceeded");
      assert.ok(result.error.limit && "limitName" in result.error.limit);
      assert.equal(
        result.error.limit.limitName,
        "caller_connect_poll_requests_per_ip_per_minute"
      );
      assert.equal(controlQuery.calls.length, 1);
      assert.deepEqual(controlQuery.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_poll_requests_per_ip_per_minute"
      ]);
      assert.doesNotMatch(
        controlQuery.calls[0].sql,
        /agent_outbox_caller_setup_requests/
      );
    }
  );
});

test("exchange per-IP abuse control blocks before setup lookup", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const controlQuery = fakeQuery(() => [{ used_units: "31" }]);
      const runner = fakeTransactionRunner([controlQuery]);

      const result = await handleConnectExchangeRequest(
        connectRequest("/api/caller/connect/exchange"),
        { requestId: "req-exchange", correlationId: "corr-exchange" },
        { setup_code: "setup_pending" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected exchange rate limit");
      }
      assert.equal(result.error.status, 429);
      assert.equal(result.error.code, "rate_limit_exceeded");
      assert.ok(result.error.limit && "limitName" in result.error.limit);
      assert.equal(
        result.error.limit.limitName,
        "caller_connect_exchange_requests_per_ip_per_minute"
      );
      assert.equal(controlQuery.calls.length, 1);
      assert.deepEqual(controlQuery.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_exchange_requests_per_ip_per_minute"
      ]);
      assert.doesNotMatch(
        controlQuery.calls[0].sql,
        /agent_outbox_caller_setup_requests/
      );
    }
  );
});

test("pending connect credentials cannot authenticate caller data-plane requests", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const parsed = parseCallerApiKey(material.plaintextApiKey);
      assert.equal(parsed.ok, true);

      const result = await authenticateCallerApiRequest(
        new Request("https://app.agent-outbox.dev/api/input/send", {
          headers: { authorization: `Bearer ${material.plaintextApiKey}` }
        }),
        async () => ({
          accountId: ACCOUNT_ID,
          callerId: CALLER_ID,
          keyId: material.keyId,
          secretDigest: material.secretDigest,
          status: "pending_activation"
        }),
        { now: new Date("2026-07-02T00:00:00.000Z") }
      );

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected pending credential auth failure");
      }
      assert.deepEqual(result.clientError, {
        status: 401,
        code: "invalid_caller_credentials",
        message: "Caller credentials are invalid or no longer usable."
      });
      assert.equal(result.internal.reason, "credential_not_active");
    }
  );
});

test("connect activate is the only step that activates the pending credential and emits the caller_registered audit", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const { runner, controlQuery, callerQuery } =
        pendingConnectRunner(material);

      const result = await handleConnectActivateRequest(
        connectRequest("/api/caller/connect/activate", {
          headers: { authorization: `Bearer ${material.plaintextApiKey}` }
        }),
        {
          requestId: "req-connect-activate",
          correlationId: "corr-connect-activate"
        },
        { setup_request_id: SETUP_REQUEST_ID },
        {
          now: new Date("2026-07-02T00:01:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.deepEqual(result, {
        ok: true,
        data: {
          caller_id: CALLER_ID,
          activated_key_id: material.keyId,
          activated_at: "2026-07-02T00:01:00.000Z"
        }
      });
      assert.equal(controlQuery.calls.length, 2);
      assert.deepEqual(controlQuery.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_activation_requests_per_ip_per_minute"
      ]);
      assert.equal(runner.contexts[1]?.authSurface, "caller");
      assert.equal(runner.contexts[1]?.callerId, CALLER_ID);
      // The pending credential is resolved by the bearer key AND its setup
      // request, never by setup request alone.
      assert.match(
        callerQuery.calls[0].sql,
        /pending_replacement_setup_request_id = \$2/
      );
      assert.deepEqual(callerQuery.calls[0].values, [
        material.keyId,
        SETUP_REQUEST_ID
      ]);
      assert.match(callerQuery.calls[1].sql, /status = 'active'/);
      // The activation UPDATE is guarded to the pending_activation state, so a
      // regression dropping the guard (allowing an already-active or otherwise
      // non-pending row to be re-activated) fails here.
      assert.match(callerQuery.calls[1].sql, /status = 'pending_activation'/);
      assert.match(callerQuery.calls[2].sql, /'caller_registered'/);
      // Connect has no prior credential, so activation revokes nothing.
      const mutationSql = callerQuery.calls
        .slice(1)
        .map((call) => call.sql)
        .join("\n");
      assert.doesNotMatch(mutationSql, /status = 'revoked'/);
    }
  );
});

test("connect abort expires the pending credential and leaves no active or revoked key", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const { runner, controlQuery, callerQuery } =
        pendingConnectRunner(material);

      const result = await handleConnectAbortRequest(
        connectRequest("/api/caller/connect/abort", {
          headers: { authorization: `Bearer ${material.plaintextApiKey}` }
        }),
        {
          requestId: "req-connect-abort",
          correlationId: "corr-connect-abort"
        },
        { setup_request_id: SETUP_REQUEST_ID },
        {
          now: new Date("2026-07-02T00:01:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.deepEqual(result, {
        ok: true,
        data: {
          caller_id: CALLER_ID,
          aborted_key_id: material.keyId,
          aborted_at: "2026-07-02T00:01:00.000Z"
        }
      });
      assert.deepEqual(controlQuery.calls[0].values?.slice(0, 2), [
        CONNECT_TEST_IP,
        "caller_connect_activation_requests_per_ip_per_minute"
      ]);
      assert.match(callerQuery.calls[1].sql, /status = 'expired'/);
      // The expire UPDATE is guarded to the pending_activation state so abort
      // can never expire an already-active credential; dropping the guard fails
      // this assertion.
      assert.match(callerQuery.calls[1].sql, /status = 'pending_activation'/);
      assert.match(
        callerQuery.calls[1].sql,
        /pending_replacement_setup_request_id = null/
      );
      const mutationSql = callerQuery.calls
        .slice(1)
        .map((call) => call.sql)
        .join("\n");
      // Abort must not activate, revoke, or emit a registration audit; there is
      // no active hosted key after a persistence failure.
      assert.doesNotMatch(mutationSql, /status = 'active'/);
      assert.doesNotMatch(mutationSql, /status = 'revoked'/);
      assert.doesNotMatch(mutationSql, /caller_registered/);
    }
  );
});

test("expired pending connect activate and abort requests fail and expire the pending key", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      for (const action of ["activate", "abort"]) {
        const material = generateCallerApiKeyMaterial();
        const { runner, callerQuery } = pendingConnectRunner(material, {
          expiresAt: "2026-07-02T00:00:30.000Z"
        });
        const handler =
          action === "activate"
            ? handleConnectActivateRequest
            : handleConnectAbortRequest;

        const result = await handler(
          connectRequest(`/api/caller/connect/${action}`, {
            headers: { authorization: `Bearer ${material.plaintextApiKey}` }
          }),
          {
            requestId: `req-connect-expired-${action}`,
            correlationId: `corr-connect-expired-${action}`
          },
          { setup_request_id: SETUP_REQUEST_ID },
          {
            now: new Date("2026-07-02T00:01:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.equal(result.ok, false, action);
        if (result.ok) {
          assert.fail(`expected expired pending connect ${action} to fail`);
        }
        assert.equal(result.error.status, 401, action);
        assert.equal(result.error.code, "invalid_caller_credentials", action);
        assert.equal(runner.contexts[1]?.authSurface, "caller", action);
        // Verification self-expires the stale pending key before rejecting.
        assert.match(callerQuery.calls[1].sql, /status = 'expired'/);
        assert.match(
          callerQuery.calls[1].sql,
          /pending_replacement_setup_request_id = null/
        );
        const mutationSql = callerQuery.calls
          .slice(1)
          .map((call) => call.sql)
          .join("\n");
        assert.doesNotMatch(mutationSql, /status = 'active'/);
        assert.doesNotMatch(mutationSql, /status = 'revoked'/);
      }
    }
  );
});

test("connect activate and abort reject a pending credential that is no longer pending_activation", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      for (const action of ["activate", "abort"]) {
        const material = generateCallerApiKeyMaterial();
        // The bearer still resolves to a live pending credential at control-plane
        // lookup, but by the time the caller transaction locks the row it is no
        // longer pending_activation (e.g. a concurrent activate already won).
        // The state-machine guard must reject rather than re-activating or
        // expiring an already-active key.
        const { runner, callerQuery } = pendingConnectRunner(material, {
          pendingStatus: "active"
        });
        const handler =
          action === "activate"
            ? handleConnectActivateRequest
            : handleConnectAbortRequest;

        const result = await handler(
          connectRequest(`/api/caller/connect/${action}`, {
            headers: { authorization: `Bearer ${material.plaintextApiKey}` }
          }),
          {
            requestId: `req-connect-nonpending-${action}`,
            correlationId: `corr-connect-nonpending-${action}`
          },
          { setup_request_id: SETUP_REQUEST_ID },
          {
            now: new Date("2026-07-02T00:01:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.equal(result.ok, false, action);
        if (result.ok) {
          assert.fail(`expected non-pending connect ${action} to fail`);
        }
        assert.equal(result.error.status, 401, action);
        assert.equal(result.error.code, "invalid_caller_credentials", action);
        assert.equal(runner.contexts[1]?.authSurface, "caller", action);
        // The guard rejects the locked row before any activate/expire mutation
        // runs, so only the SELECT executed inside the caller transaction.
        assert.equal(callerQuery.calls.length, 1, action);
      }
    }
  );
});

test("connect activate and abort reject a bearer whose secret does not match the stored pending digest", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      for (const action of ["activate", "abort"]) {
        const material = generateCallerApiKeyMaterial();
        const wrongMaterial = generateCallerApiKeyMaterial();
        // Control-plane lookup sees the bearer's own digest and passes, but the
        // locked row's stored HMAC digest belongs to a different secret. The
        // constant-time secret check inside the caller transaction must reject
        // before any activate/expire mutation runs.
        const { runner, callerQuery } = pendingConnectRunner(material, {
          pendingSecretDigest: wrongMaterial.secretDigest
        });
        const handler =
          action === "activate"
            ? handleConnectActivateRequest
            : handleConnectAbortRequest;

        const result = await handler(
          connectRequest(`/api/caller/connect/${action}`, {
            headers: { authorization: `Bearer ${material.plaintextApiKey}` }
          }),
          {
            requestId: `req-connect-wrongsecret-${action}`,
            correlationId: `corr-connect-wrongsecret-${action}`
          },
          { setup_request_id: SETUP_REQUEST_ID },
          {
            now: new Date("2026-07-02T00:01:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.equal(result.ok, false, action);
        if (result.ok) {
          assert.fail(`expected wrong-secret connect ${action} to fail`);
        }
        assert.equal(result.error.status, 401, action);
        assert.equal(result.error.code, "invalid_caller_credentials", action);
        // The failure happens inside the caller transaction (past the matching
        // control-plane lookup), and before the SELECT-only transaction mutates.
        assert.equal(runner.contexts[1]?.authSurface, "caller", action);
        assert.equal(callerQuery.calls.length, 1, action);
      }
    }
  );
});

test("malformed setup_request_id fails validation before connect activate and abort transactions", async () => {
  const cases = [
    {
      name: "activate",
      handler: handleConnectActivateRequest,
      path: "/api/caller/connect/activate"
    },
    {
      name: "abort",
      handler: handleConnectAbortRequest,
      path: "/api/caller/connect/abort"
    }
  ];

  for (const testCase of cases) {
    const runner = fakeTransactionRunner([]);
    const result = await testCase.handler(
      connectRequest(testCase.path),
      {
        requestId: `req-connect-malformed-${testCase.name}`,
        correlationId: `corr-connect-malformed-${testCase.name}`
      },
      { setup_request_id: "not-a-uuid" },
      { runProductTransaction: runner.runProductTransaction }
    );

    assert.equal(result.ok, false, testCase.name);
    if (result.ok) {
      assert.fail(
        `expected malformed setup_request_id ${testCase.name} to fail`
      );
    }
    assert.equal(result.error.status, 422);
    assert.equal(result.error.code, "validation_failed");
    assert.deepEqual(result.error.fields, [
      {
        path: "setup_request_id",
        code: "invalid_uuid",
        message: "setup_request_id must be a UUID-formatted string."
      }
    ]);
    assert.equal(
      runner.contexts.length,
      0,
      `malformed setup_request_id ${testCase.name} must fail before the transaction runner`
    );
  }
});
