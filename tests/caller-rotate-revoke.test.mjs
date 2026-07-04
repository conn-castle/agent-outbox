import assert from "node:assert/strict";
import test from "node:test";

import { authenticateCallerApiRequest } from "../src/server/caller-api-auth.ts";
import { generateCallerApiKeyMaterial } from "../src/server/caller-auth.ts";
import {
  approveCredentialOperationBrowserSetupRequest,
  approveCredentialOperationDeviceSetupRequest,
  denyCredentialOperationSetupRequest,
  handleRevokeConfirmRequest,
  handleRevokeBrowserStartRequest,
  handleRevokeDeviceStartRequest,
  handleRevokeDevicePollRequest,
  handleRotateAbortRequest,
  handleRotateActivateRequest,
  handleRotateBrowserStartRequest,
  handleRotateDeviceStartRequest,
  handleRotateExchangeRequest
} from "../src/server/caller-credential-operations.ts";

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const CALLER_ID = "00000000-0000-4000-8000-000000000003";
const SETUP_REQUEST_ID = "10000000-0000-4000-8000-000000000301";
const OLD_CREDENTIAL_ID = "20000000-0000-4000-8000-000000000401";
const PENDING_CREDENTIAL_ID = "20000000-0000-4000-8000-000000000402";
const TEST_IP = "203.0.113.55";

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
 * @param {(statement: TransactionContextStatement, callNumber: number) => import("pg").QueryResultRow[]} resolver
 * @returns {MockProductTransactionQuery}
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
 * @param {string} sql
 */
function denialSqlScopesCallerToActingAccount(sql) {
  return (
    /update\s+public\.agent_outbox_caller_setup_requests\s+setup/i.test(sql) &&
    /from\s+public\.agent_outbox_callers\s+caller/i.test(sql) &&
    /caller\.caller_id\s*=\s*setup\.caller_id/i.test(sql) &&
    /caller\.account_id\s*=\s*\$3/i.test(sql) &&
    /caller\.revoked_at\s+is\s+null/i.test(sql)
  );
}

/**
 * @param {string} path
 * @param {RequestInit & { headers?: Record<string, string> }} [init]
 */
function controlRequest(path, init = {}) {
  return new Request(`https://app.agent-outbox.dev${path}`, {
    ...init,
    headers: {
      "cf-connecting-ip": TEST_IP,
      ...(init.headers ?? {})
    }
  });
}

test("browser rotate start creates a rotate setup request after IP limiting", async () => {
  await withProcessEnv(
    {
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const query = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [{ used_units: "1" }];
        }
        return [
          {
            setup_request_id: SETUP_REQUEST_ID,
            display_name: "Steward Email"
          }
        ];
      });
      const runner = fakeTransactionRunner([query]);

      const result = await handleRotateBrowserStartRequest(
        controlRequest("/api/caller/rotate/browser/start"),
        { requestId: "req-rotate-start", correlationId: "corr-rotate-start" },
        {
          caller_id: CALLER_ID,
          local_caller_name: "steward-email",
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
            "https://app.agent-outbox.dev/caller/rotate/approve?setup_request_id=10000000-0000-4000-8000-000000000301",
          setup_request_id: SETUP_REQUEST_ID,
          expires_at: "2026-07-02T00:10:00.000Z"
        }
      });
      assert.equal(runner.contexts[0]?.authSurface, "control_plane");
      assert.deepEqual(query.calls[0].values?.slice(0, 2), [
        TEST_IP,
        "caller_rotate_start_requests_per_ip_per_minute"
      ]);
      assert.match(query.calls[1].sql, /values \(\$1, 'browser'/);
      assert.deepEqual(query.calls[1].values, [
        "rotate",
        CALLER_ID,
        "steward-email",
        "http://127.0.0.1:49152/callback",
        "2026-07-02T00:10:00.000Z",
        5
      ]);
    }
  );
});

test("malformed caller_id fails validation before rotate and revoke start transactions", async () => {
  const cases = [
    {
      name: "rotate browser start",
      handler: handleRotateBrowserStartRequest,
      path: "/api/caller/rotate/browser/start",
      body: {
        caller_id: "not-a-uuid",
        local_caller_name: "steward-email",
        callback_url: "http://127.0.0.1:49152/callback"
      }
    },
    {
      name: "rotate device start",
      handler: handleRotateDeviceStartRequest,
      path: "/api/caller/rotate/device/start",
      body: {
        caller_id: "not-a-uuid",
        local_caller_name: "steward-email"
      }
    },
    {
      name: "revoke browser start",
      handler: handleRevokeBrowserStartRequest,
      path: "/api/caller/revoke/browser/start",
      body: {
        caller_id: "not-a-uuid",
        local_caller_name: "steward-email",
        callback_url: "http://127.0.0.1:49152/callback"
      }
    },
    {
      name: "revoke device start",
      handler: handleRevokeDeviceStartRequest,
      path: "/api/caller/revoke/device/start",
      body: {
        caller_id: "not-a-uuid",
        local_caller_name: "steward-email"
      }
    }
  ];

  for (const testCase of cases) {
    const runner = fakeTransactionRunner([]);
    const result = await testCase.handler(
      controlRequest(testCase.path),
      {
        requestId: `req-${testCase.name}`,
        correlationId: `corr-${testCase.name}`
      },
      testCase.body,
      { runProductTransaction: runner.runProductTransaction }
    );

    assert.equal(result.ok, false, testCase.name);
    if (result.ok) {
      assert.fail(`expected ${testCase.name} to fail validation`);
    }
    assert.equal(result.error.status, 422);
    assert.equal(result.error.code, "validation_failed");
    assert.deepEqual(result.error.fields, [
      {
        path: "caller_id",
        code: "invalid_uuid",
        message: "caller_id must be a UUID-formatted string."
      }
    ]);
    assert.equal(
      runner.contexts.length,
      0,
      `${testCase.name} must fail before the transaction runner`
    );
  }
});

test("malformed setup_request_id fails validation before rotate activate and abort transactions", async () => {
  const cases = [
    {
      name: "activate",
      handler: handleRotateActivateRequest,
      path: "/api/caller/rotate/activate"
    },
    {
      name: "abort",
      handler: handleRotateAbortRequest,
      path: "/api/caller/rotate/abort"
    }
  ];

  for (const testCase of cases) {
    const runner = fakeTransactionRunner([]);
    const result = await testCase.handler(
      controlRequest(testCase.path),
      {
        requestId: `req-rotate-malformed-${testCase.name}`,
        correlationId: `corr-rotate-malformed-${testCase.name}`
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

test("device revoke poll returns authorization_pending before approval and a display-once setup code after approval", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const pendingQuery = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [{ used_units: "1" }];
        }
        return [
          {
            setup_request_id: SETUP_REQUEST_ID,
            status: "pending",
            setup_code_hash: null,
            poll_interval_seconds: 5,
            expires_at: "2026-07-02T00:10:00.000Z"
          }
        ];
      });
      const pendingRunner = fakeTransactionRunner([pendingQuery]);
      const pending = await handleRevokeDevicePollRequest(
        controlRequest("/api/caller/revoke/device/poll"),
        {
          requestId: "req-revoke-pending",
          correlationId: "corr-revoke-pending"
        },
        { device_code: "dev_pending" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: pendingRunner.runProductTransaction
        }
      );

      assert.equal(pending.ok, false);
      if (pending.ok) {
        assert.fail("expected pending revoke poll to return 202");
      }
      assert.equal(pending.error.status, 202);
      assert.equal(pending.error.code, "authorization_pending");

      const approvedQuery = fakeQuery((_statement, callNumber) => {
        if (callNumber === 1) {
          return [{ used_units: "1" }];
        }
        if (callNumber === 2) {
          return [
            {
              setup_request_id: SETUP_REQUEST_ID,
              status: "approved",
              setup_code_hash: null,
              poll_interval_seconds: 5,
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        return [];
      });
      const approvedRunner = fakeTransactionRunner([approvedQuery]);
      const approved = await handleRevokeDevicePollRequest(
        controlRequest("/api/caller/revoke/device/poll"),
        {
          requestId: "req-revoke-approved",
          correlationId: "corr-revoke-approved"
        },
        { device_code: "dev_approved" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: approvedRunner.runProductTransaction
        }
      );

      assert.equal(approved.ok, true);
      if (!approved.ok) {
        assert.fail("expected approved revoke poll to return setup code");
      }
      assert.match(approved.data.setup_code, /^setup_/);
      assert.match(approvedQuery.calls[2].sql, /setup_code_hash = \$2/);
      assert.equal(approvedQuery.calls[2].values?.[0], SETUP_REQUEST_ID);
      assert.match(
        String(approvedQuery.calls[2].values?.[1]),
        /^[a-f0-9]{64}$/
      );
      assert.doesNotMatch(
        JSON.stringify(approvedQuery.calls),
        new RegExp(approved.data.setup_code)
      );
    }
  );
});

test("rotate exchange creates only a pending replacement credential and does not revoke the old key", async () => {
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
        return [
          {
            setup_request_id: SETUP_REQUEST_ID,
            status: "approved",
            account_id: ACCOUNT_ID,
            approved_by_user_id: USER_ID,
            expires_at: "2026-07-02T00:10:00.000Z"
          }
        ];
      });
      const humanQuery = fakeQuery((statement, callNumber) => {
        if (callNumber === 1 || callNumber === 3) {
          return [
            {
              setup_request_id: SETUP_REQUEST_ID,
              status: "approved",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              expires_at: "2026-07-02T00:10:00.000Z",
              caller_slug: "steward-email",
              caller_display_name: "Steward Email",
              account_label: "Owner",
              account_tier: "hosted_free",
              active_credential_id: OLD_CREDENTIAL_ID,
              active_key_id: "old_key",
              active_key_last_four: "abcd"
            }
          ];
        }
        if (callNumber === 2) {
          assert.match(statement.sql, /pg_advisory_xact_lock/);
          assert.deepEqual(statement.values, [ACCOUNT_ID, CALLER_ID]);
          return [];
        }
        if (callNumber === 4) {
          assert.match(statement.sql, /status = 'expired'/);
          assert.match(statement.sql, /expires_at <= \$3::timestamptz/);
          assert.deepEqual(statement.values, [
            ACCOUNT_ID,
            CALLER_ID,
            "2026-07-02T00:00:00.000Z"
          ]);
          return [];
        }
        if (callNumber === 5) {
          return [
            {
              caller_credential_id: PENDING_CREDENTIAL_ID,
              key_id: "new_key",
              key_prefix: "aob_live",
              key_last_four: "wxyz",
              secret_hmac_sha256: "a".repeat(64),
              status: "pending_activation",
              expires_at: "2026-07-02T00:10:00.000Z",
              revoked_at: null,
              created_at: "2026-07-02T00:00:01.000Z",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              pending_replacement_for_credential_id: OLD_CREDENTIAL_ID,
              pending_replacement_setup_request_id: SETUP_REQUEST_ID,
              old_key_id: null,
              old_key_last_four: null
            }
          ];
        }
        return [];
      });
      const runner = fakeTransactionRunner([controlQuery, humanQuery]);

      const result = await handleRotateExchangeRequest(
        controlRequest("/api/caller/rotate/exchange"),
        {
          requestId: "req-rotate-exchange",
          correlationId: "corr-rotate-exchange"
        },
        { setup_code: "setup_rotate" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.equal(result.ok, true);
      if (!result.ok) {
        assert.fail("expected rotate exchange success");
      }
      assert.match(result.data.replacement_credential.api_key, /^aob_live_/);
      assert.deepEqual(result.data.replaces_credential, {
        key_id: "old_key",
        last_chars: "abcd"
      });
      assert.equal(runner.contexts[0]?.authSurface, "control_plane");
      assert.deepEqual(
        {
          authSurface: runner.contexts[1]?.authSurface,
          accountId: runner.contexts[1]?.accountId,
          userId: runner.contexts[1]?.userId
        },
        { authSurface: "human", accountId: ACCOUNT_ID, userId: USER_ID }
      );
      const insertCall = humanQuery.calls.find((call) =>
        /insert into public\.agent_outbox_caller_credentials/i.test(call.sql)
      );
      assert.ok(insertCall, "expected pending replacement insert");
      assert.match(insertCall.sql, /'pending_activation'/);
      assert.deepEqual(insertCall.values?.slice(6), [
        "2026-07-02T00:10:00.000Z",
        OLD_CREDENTIAL_ID,
        SETUP_REQUEST_ID
      ]);
      assert.equal(
        humanQuery.calls.some((call) => /status = 'revoked'/.test(call.sql)),
        false
      );
    }
  );
});

test("rotate exchange expires abandoned expired pending replacements before creating a later pending key", async () => {
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
        return [
          {
            setup_request_id: SETUP_REQUEST_ID,
            status: "approved",
            account_id: ACCOUNT_ID,
            approved_by_user_id: USER_ID,
            expires_at: "2026-07-02T00:10:00.000Z"
          }
        ];
      });
      let sawExpiredPendingCleanup = false;
      const humanQuery = fakeQuery((statement, callNumber) => {
        if (callNumber === 1 || callNumber === 3) {
          return [
            {
              setup_request_id: SETUP_REQUEST_ID,
              status: "approved",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              expires_at: "2026-07-02T00:10:00.000Z",
              caller_slug: "steward-email",
              caller_display_name: "Steward Email",
              account_label: "Owner",
              account_tier: "hosted_free",
              active_credential_id: OLD_CREDENTIAL_ID,
              active_key_id: "old_key",
              active_key_last_four: "abcd"
            }
          ];
        }

        if (callNumber === 2) {
          assert.match(statement.sql, /pg_advisory_xact_lock/);
          assert.deepEqual(statement.values, [ACCOUNT_ID, CALLER_ID]);
          return [];
        }

        if (
          /update public\.agent_outbox_caller_credentials/i.test(
            statement.sql
          ) &&
          /status = 'expired'/.test(statement.sql) &&
          /expires_at <= \$3::timestamptz/.test(statement.sql)
        ) {
          sawExpiredPendingCleanup = true;
          assert.deepEqual(statement.values, [
            ACCOUNT_ID,
            CALLER_ID,
            "2026-07-02T00:05:00.000Z"
          ]);
          return [];
        }

        if (
          /insert into public\.agent_outbox_caller_credentials/i.test(
            statement.sql
          )
        ) {
          assert.equal(
            sawExpiredPendingCleanup,
            true,
            "expired pending replacement cleanup must run before insert"
          );
          return [
            {
              caller_credential_id: PENDING_CREDENTIAL_ID,
              key_id: "new_key",
              key_prefix: "aob_live",
              key_last_four: "wxyz",
              secret_hmac_sha256: "a".repeat(64),
              status: "pending_activation",
              expires_at: "2026-07-02T00:10:00.000Z",
              revoked_at: null,
              created_at: "2026-07-02T00:05:01.000Z",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              pending_replacement_for_credential_id: OLD_CREDENTIAL_ID,
              pending_replacement_setup_request_id: SETUP_REQUEST_ID,
              old_key_id: null,
              old_key_last_four: null
            }
          ];
        }

        return [];
      });
      const runner = fakeTransactionRunner([controlQuery, humanQuery]);

      const result = await handleRotateExchangeRequest(
        controlRequest("/api/caller/rotate/exchange"),
        {
          requestId: "req-rotate-exchange-after-expired-pending",
          correlationId: "corr-rotate-exchange-after-expired-pending"
        },
        { setup_code: "setup_rotate" },
        {
          now: new Date("2026-07-02T00:05:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.equal(result.ok, true);
      assert.equal(sawExpiredPendingCleanup, true);
      assert.equal(
        humanQuery.calls.some((call) => /status = 'revoked'/.test(call.sql)),
        false
      );
    }
  );
});

test("rotate exchange still rejects a live pending replacement after expired cleanup", async () => {
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
        return [
          {
            setup_request_id: SETUP_REQUEST_ID,
            status: "approved",
            account_id: ACCOUNT_ID,
            approved_by_user_id: USER_ID,
            expires_at: "2026-07-02T00:10:00.000Z"
          }
        ];
      });
      const humanQuery = fakeQuery((statement, callNumber) => {
        if (callNumber === 1 || callNumber === 3) {
          return [
            {
              setup_request_id: SETUP_REQUEST_ID,
              status: "approved",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              expires_at: "2026-07-02T00:10:00.000Z",
              caller_slug: "steward-email",
              caller_display_name: "Steward Email",
              account_label: "Owner",
              account_tier: "hosted_free",
              active_credential_id: OLD_CREDENTIAL_ID,
              active_key_id: "old_key",
              active_key_last_four: "abcd"
            }
          ];
        }

        if (callNumber === 2) {
          assert.match(statement.sql, /pg_advisory_xact_lock/);
          assert.deepEqual(statement.values, [ACCOUNT_ID, CALLER_ID]);
          return [];
        }

        if (/expires_at <= \$3::timestamptz/.test(statement.sql)) {
          return [];
        }

        if (
          /insert into public\.agent_outbox_caller_credentials/i.test(
            statement.sql
          )
        ) {
          throw Object.assign(new Error("duplicate pending replacement"), {
            code: "23505"
          });
        }

        return [];
      });
      const runner = fakeTransactionRunner([controlQuery, humanQuery]);

      const result = await handleRotateExchangeRequest(
        controlRequest("/api/caller/rotate/exchange"),
        {
          requestId: "req-rotate-exchange-live-pending",
          correlationId: "corr-rotate-exchange-live-pending"
        },
        { setup_code: "setup_rotate" },
        {
          now: new Date("2026-07-02T00:00:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 400,
          code: "invalid_request",
          message: "Caller already has a pending replacement key."
        }
      });
      assert.equal(
        humanQuery.calls.some((call) => /status = 'exchanged'/.test(call.sql)),
        false
      );
    }
  );
});

test("rotate and revoke approvals use distinct account-scoped limit buckets", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      /** @param {MockProductTransactionQuery} query */
      const approveRotate = (query) =>
        approveCredentialOperationBrowserSetupRequest(query, {
          operation: "rotate",
          setupRequestId: SETUP_REQUEST_ID,
          accountId: ACCOUNT_ID,
          userId: USER_ID,
          now: new Date("2026-07-02T00:00:00.000Z")
        });
      /** @param {MockProductTransactionQuery} query */
      const approveRevoke = (query) =>
        approveCredentialOperationDeviceSetupRequest(query, {
          operation: "revoke",
          userCode: "ABCD-EFGH",
          accountId: ACCOUNT_ID,
          userId: USER_ID,
          now: new Date("2026-07-02T00:00:00.000Z")
        });
      const approvals = [
        {
          operation: "rotate",
          limitName: "caller_rotate_approvals_per_account_per_minute",
          run: approveRotate
        },
        {
          operation: "revoke",
          limitName: "caller_revoke_approvals_per_account_per_minute",
          run: approveRevoke
        }
      ];

      for (const approval of approvals) {
        const query = fakeQuery((_statement, callNumber) => {
          if (callNumber === 1) {
            return [
              {
                setup_request_id: SETUP_REQUEST_ID,
                operation: approval.operation,
                status: "pending",
                local_caller_name: "steward-email",
                display_name: "Steward Email",
                callback_url:
                  approval.operation === "rotate"
                    ? "http://127.0.0.1:49152/callback"
                    : null,
                expires_at: "2026-07-02T00:10:00.000Z",
                caller_id: CALLER_ID,
                caller_slug: "steward-email",
                caller_display_name: "Steward Email",
                active_credential_id: OLD_CREDENTIAL_ID,
                active_key_id: "old_key",
                active_key_last_four: "abcd"
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
          return [];
        });

        const result = await approval.run(query);

        assert.equal(result.ok, true);
        if (!result.ok) {
          assert.fail(`expected ${approval.operation} approval success`);
        }
        assert.deepEqual(query.calls[3].values?.slice(0, 2), [
          ACCOUNT_ID,
          approval.limitName
        ]);
        if (approval.operation === "revoke") {
          assert.match(
            query.calls[0].sql,
            /setup\.status in \('pending', 'approved'\)/
          );
          assert.match(query.calls[0].sql, /setup\.expires_at > now\(\)/);
          assert.match(
            query.calls[0].sql,
            /order by setup\.expires_at desc, setup\.created_at desc/
          );
          assert.match(query.calls[0].sql, /limit 1/);
        }
      }
    }
  );
});

test("rotate and revoke denial rejects setup requests whose caller belongs to another account", async () => {
  for (const operation of /** @type {const} */ (["rotate", "revoke"])) {
    const query = fakeQuery((statement, callNumber) => {
      assert.equal(callNumber, 1);
      assert.deepEqual(statement.values, [
        SETUP_REQUEST_ID,
        operation,
        ACCOUNT_ID
      ]);

      return denialSqlScopesCallerToActingAccount(statement.sql)
        ? []
        : [{ setup_request_id: SETUP_REQUEST_ID }];
    });

    const result = await denyCredentialOperationSetupRequest(query, {
      operation,
      setupRequestId: SETUP_REQUEST_ID,
      accountId: ACCOUNT_ID
    });

    assert.equal(
      result.ok,
      false,
      `${operation} denial must not cancel a foreign-account setup request`
    );
    if (result.ok) {
      assert.fail(`expected cross-account ${operation} denial to be rejected`);
    }
    assert.equal(result.error.status, 404);
    assert.equal(result.error.code, "not_found");
  }
});

test("pending replacement keys cannot authenticate data-plane requests", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const result = await authenticateCallerApiRequest(
        new Request("https://app.agent-outbox.dev/api/input/send", {
          headers: { authorization: `Bearer ${material.plaintextApiKey}` }
        }),
        async () => ({
          accountId: ACCOUNT_ID,
          callerId: CALLER_ID,
          keyId: material.keyId,
          secretDigest: material.secretDigest,
          status: "pending_activation",
          expiresAt: "2026-07-02T00:10:00.000Z",
          revokedAt: null
        }),
        { now: new Date("2026-07-02T00:00:00.000Z") }
      );

      assert.equal(result.ok, false);
      if (result.ok) {
        assert.fail("expected pending key to fail data-plane auth");
      }
      assert.equal(result.internal.reason, "credential_not_active");
      assert.equal(result.internal.credentialStatus, "pending_activation");
    }
  );
});

test("rotate activate is the only step that activates the new key and revokes the old key", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const { runner, controlQuery, callerQuery } =
        pendingRotateRunner(material);

      const result = await handleRotateActivateRequest(
        controlRequest("/api/caller/rotate/activate", {
          headers: { authorization: `Bearer ${material.plaintextApiKey}` }
        }),
        {
          requestId: "req-rotate-activate",
          correlationId: "corr-rotate-activate"
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
          revoked_key_id: "old_key",
          activated_at: "2026-07-02T00:01:00.000Z"
        }
      });
      assert.equal(controlQuery.calls.length, 2);
      assert.equal(runner.contexts[1]?.authSurface, "caller");
      assert.equal(runner.contexts[1]?.callerId, CALLER_ID);
      assert.match(callerQuery.calls[1].sql, /pg_advisory_xact_lock/);
      assert.match(callerQuery.calls[3].sql, /status = 'revoked'/);
      assert.match(callerQuery.calls[4].sql, /status = 'active'/);
      // The activation UPDATE is guarded to the pending_activation state, so a
      // regression dropping the guard (letting a non-pending row be activated)
      // fails here.
      assert.match(callerQuery.calls[4].sql, /status = 'pending_activation'/);
      assert.match(callerQuery.calls[5].sql, /'caller_key_rotated'|\$3/);
    }
  );
});

test("rotate abort expires the pending replacement and leaves the old key active", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const { runner, callerQuery } = pendingRotateRunner(material);

      const result = await handleRotateAbortRequest(
        controlRequest("/api/caller/rotate/abort", {
          headers: { authorization: `Bearer ${material.plaintextApiKey}` }
        }),
        { requestId: "req-rotate-abort", correlationId: "corr-rotate-abort" },
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
          active_key_id: "old_key",
          aborted_at: "2026-07-02T00:01:00.000Z"
        }
      });
      assert.match(callerQuery.calls[1].sql, /pg_advisory_xact_lock/);
      assert.match(callerQuery.calls[3].sql, /status = 'expired'/);
      // The expire UPDATE is guarded to the pending_activation state so abort
      // can never expire an already-active credential; dropping the guard fails
      // this assertion.
      assert.match(callerQuery.calls[3].sql, /status = 'pending_activation'/);
      assert.equal(
        callerQuery.calls.some((call) => /status = 'revoked'/.test(call.sql)),
        false
      );
    }
  );
});

test("rotate activate and abort reject a pending replacement that is no longer pending_activation", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      for (const action of ["activate", "abort"]) {
        const material = generateCallerApiKeyMaterial();
        // The bearer still resolves to a live pending replacement at
        // control-plane lookup, but by the time the caller transaction locks the
        // row it is no longer pending_activation (e.g. a concurrent activate
        // already won). The state-machine guard must reject rather than
        // re-activating the new key / re-revoking the old one, or expiring an
        // already-active credential.
        const { runner, callerQuery } = pendingRotateRunner(material, {
          pendingStatus: "active"
        });
        const handler =
          action === "activate"
            ? handleRotateActivateRequest
            : handleRotateAbortRequest;

        const result = await handler(
          controlRequest(`/api/caller/rotate/${action}`, {
            headers: { authorization: `Bearer ${material.plaintextApiKey}` }
          }),
          {
            requestId: `req-rotate-nonpending-${action}`,
            correlationId: `corr-rotate-nonpending-${action}`
          },
          { setup_request_id: SETUP_REQUEST_ID },
          {
            now: new Date("2026-07-02T00:01:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.equal(result.ok, false, action);
        if (result.ok) {
          assert.fail(`expected non-pending rotate ${action} to fail`);
        }
        assert.equal(result.error.status, 401, action);
        assert.equal(result.error.code, "invalid_caller_credentials", action);
        assert.equal(runner.contexts[1]?.authSurface, "caller", action);
        // The guard rejects the locked row before any revoke/activate/expire
        // mutation runs, after the scope lookup and lifecycle lock.
        assert.equal(callerQuery.calls.length, 3, action);
        assert.match(callerQuery.calls[1].sql, /pg_advisory_xact_lock/);
      }
    }
  );
});

test("rotate activate and abort reject a bearer whose secret does not match the stored pending digest", async () => {
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
        // before any revoke/activate/expire mutation runs.
        const { runner, callerQuery } = pendingRotateRunner(material, {
          pendingSecretDigest: wrongMaterial.secretDigest
        });
        const handler =
          action === "activate"
            ? handleRotateActivateRequest
            : handleRotateAbortRequest;

        const result = await handler(
          controlRequest(`/api/caller/rotate/${action}`, {
            headers: { authorization: `Bearer ${material.plaintextApiKey}` }
          }),
          {
            requestId: `req-rotate-wrongsecret-${action}`,
            correlationId: `corr-rotate-wrongsecret-${action}`
          },
          { setup_request_id: SETUP_REQUEST_ID },
          {
            now: new Date("2026-07-02T00:01:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.equal(result.ok, false, action);
        if (result.ok) {
          assert.fail(`expected wrong-secret rotate ${action} to fail`);
        }
        assert.equal(result.error.status, 401, action);
        assert.equal(result.error.code, "invalid_caller_credentials", action);
        // The failure happens inside the caller transaction (past the matching
        // control-plane lookup), and before the SELECT-only transaction mutates.
        assert.equal(runner.contexts[1]?.authSurface, "caller", action);
        assert.equal(callerQuery.calls.length, 3, action);
        assert.match(callerQuery.calls[1].sql, /pg_advisory_xact_lock/);
      }
    }
  );
});

test("expired pending replacement activate and abort requests fail and expire the pending key", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      for (const action of ["activate", "abort"]) {
        const material = generateCallerApiKeyMaterial();
        const { runner, callerQuery } = pendingRotateRunner(material, {
          expiresAt: "2026-07-02T00:00:30.000Z"
        });
        const handler =
          action === "activate"
            ? handleRotateActivateRequest
            : handleRotateAbortRequest;

        const result = await handler(
          controlRequest(`/api/caller/rotate/${action}`, {
            headers: { authorization: `Bearer ${material.plaintextApiKey}` }
          }),
          {
            requestId: `req-rotate-expired-${action}`,
            correlationId: `corr-rotate-expired-${action}`
          },
          { setup_request_id: SETUP_REQUEST_ID },
          {
            now: new Date("2026-07-02T00:01:00.000Z"),
            runProductTransaction: runner.runProductTransaction
          }
        );

        assert.equal(result.ok, false);
        if (result.ok) {
          assert.fail(`expected expired pending key ${action} to fail`);
        }
        assert.equal(result.error.status, 401);
        assert.equal(result.error.code, "invalid_caller_credentials");
        assert.equal(runner.contexts[1]?.authSurface, "caller");
        assert.match(callerQuery.calls[1].sql, /pg_advisory_xact_lock/);
        assert.match(callerQuery.calls[3].sql, /status = 'expired'/);
        assert.match(
          callerQuery.calls[3].sql,
          /pending_replacement_setup_request_id = null/
        );

        const mutationSql = callerQuery.calls
          .slice(3)
          .map((call) => call.sql)
          .join("\n");
        assert.doesNotMatch(mutationSql, /status = 'revoked'/);
        assert.doesNotMatch(mutationSql, /status = 'active'/);
      }
    }
  );
});

test("revoke confirm revokes credentials without deleting caller history, queue rows, logs, or limits", async () => {
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
        return [
          {
            setup_request_id: SETUP_REQUEST_ID,
            status: "approved",
            account_id: ACCOUNT_ID,
            approved_by_user_id: USER_ID,
            expires_at: "2026-07-02T00:10:00.000Z"
          }
        ];
      });
      const humanQuery = fakeQuery((statement, callNumber) => {
        if (callNumber === 1) {
          return [
            {
              setup_request_id: SETUP_REQUEST_ID,
              status: "approved",
              account_id: ACCOUNT_ID,
              caller_id: CALLER_ID,
              expires_at: "2026-07-02T00:10:00.000Z"
            }
          ];
        }
        if (callNumber === 2) {
          assert.match(statement.sql, /pg_advisory_xact_lock/);
          assert.deepEqual(statement.values, [ACCOUNT_ID, CALLER_ID]);
          return [];
        }
        if (callNumber === 3) {
          return [{ key_id: "old_key" }];
        }
        return [];
      });
      const runner = fakeTransactionRunner([controlQuery, humanQuery]);

      const result = await handleRevokeConfirmRequest(
        controlRequest("/api/caller/revoke/confirm"),
        {
          requestId: "req-revoke-confirm",
          correlationId: "corr-revoke-confirm"
        },
        { setup_code: "setup_revoke" },
        {
          now: new Date("2026-07-02T00:01:00.000Z"),
          runProductTransaction: runner.runProductTransaction
        }
      );

      assert.deepEqual(result, {
        ok: true,
        data: {
          caller_id: CALLER_ID,
          revoked_key_ids: ["old_key"],
          revoked_at: "2026-07-02T00:01:00.000Z"
        }
      });
      assert.match(humanQuery.calls[1].sql, /pg_advisory_xact_lock/);
      assert.match(humanQuery.calls[2].sql, /agent_outbox_caller_credentials/);
      assert.match(humanQuery.calls[2].sql, /status = 'revoked'/);
      const serializedSql = humanQuery.calls.map((call) => call.sql).join("\n");
      assert.doesNotMatch(
        serializedSql,
        /delete\s+from\s+public\.agent_outbox_callers/i
      );
      assert.doesNotMatch(
        serializedSql,
        /delete\s+from\s+public\.agent_outbox_input_items/i
      );
      assert.doesNotMatch(
        serializedSql,
        /delete\s+from\s+public\.agent_outbox_output_results/i
      );
      assert.doesNotMatch(
        serializedSql,
        /delete\s+from\s+public\.agent_outbox_audit_events/i
      );
      assert.doesNotMatch(
        serializedSql,
        /delete\s+from\s+public\.agent_outbox_account_quota_windows/i
      );
      assert.doesNotMatch(
        serializedSql,
        /delete\s+from\s+public\.agent_outbox_account_limit_blocks/i
      );
    }
  );
});

/**
 * @param {import("../src/server/caller-auth.ts").DisplayOnceCallerApiKeyMaterial} material
 * @param {{ expiresAt?: string, pendingStatus?: string, pendingSecretDigest?: string }} [options]
 */
function pendingRotateRunner(material, options = {}) {
  const expiresAt = options.expiresAt ?? "2026-07-02T00:10:00.000Z";
  // Overrides that apply only to the locked pending replacement row returned
  // inside the caller transaction, so a test can diverge that row from the
  // (valid) control-plane lookup to exercise the product-side state/secret
  // guards.
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
          account_id: ACCOUNT_ID,
          caller_id: CALLER_ID
        }
      ];
    }
    if (callNumber === 2) {
      return [];
    }
    if (callNumber === 3) {
      return [
        {
          caller_credential_id: PENDING_CREDENTIAL_ID,
          key_id: material.keyId,
          key_prefix: material.keyPrefix,
          key_last_four: material.keyLastCharacters,
          secret_hmac_sha256: pendingSecretDigest,
          status: pendingStatus,
          expires_at: expiresAt,
          revoked_at: null,
          created_at: "2026-07-02T00:00:01.000Z",
          account_id: ACCOUNT_ID,
          caller_id: CALLER_ID,
          pending_replacement_for_credential_id: OLD_CREDENTIAL_ID,
          pending_replacement_setup_request_id: SETUP_REQUEST_ID,
          old_key_id: "old_key",
          old_key_last_four: "abcd"
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
