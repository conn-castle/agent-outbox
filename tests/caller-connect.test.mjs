import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { enforceIpControlPlaneLimit } from "../src/server/caller-api-limits.ts";
import { authenticateCallerApiRequest } from "../src/server/caller-api-auth.ts";
import {
  generateCallerApiKeyMaterial,
  parseCallerApiKey
} from "../src/server/caller-auth.ts";
import {
  approveConnectBrowserSetupRequest,
  approveConnectDeviceSetupRequest,
  denyConnectSetupRequest,
  exchangeApprovedConnectSetupRequest,
  getConnectBrowserApprovalPreview,
  getConnectDeviceApprovalPreview,
  handleConnectAbortRequest,
  handleConnectActivateRequest,
  handleConnectBrowserStartRequest,
  handleConnectDeviceStartRequest,
  handleConnectDevicePollRequest,
  handleConnectExchangeRequest
} from "../src/server/caller-connect.ts";
import {
  handleRevokeConfirmRequest,
  handleRevokeDevicePollRequest,
  handleRotateAbortRequest,
  handleRotateActivateRequest,
  handleRotateDevicePollRequest,
  handleRotateExchangeRequest
} from "../src/server/caller-credential-operations.ts";
import {
  getSetupRequestTerminalState,
  setupCodeDigest
} from "../src/server/caller-setup-requests.ts";
import { runProductTransaction } from "../src/server/database.ts";
import {
  assertMigrationOwnerCanSetAppRole,
  DATABASE_POLICY_VERIFICATION_SKIP,
  phase3DatabaseVerificationUrl,
  preserveBodyErrorDuringTeardown,
  teardownAttempt
} from "./helpers/database.mjs";
import { withProcessEnv } from "./helpers/process-env.mjs";
import {
  fakeSavepointAwareQuery,
  fakeTransactionRunner
} from "./helpers/fake-query.mjs";

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const CALLER_ID = "00000000-0000-4000-8000-000000000003";
const CONNECT_TEST_IP = "203.0.113.44";
const SETUP_REQUEST_ID = "10000000-0000-4000-8000-000000000301";
const PENDING_CREDENTIAL_ID = "20000000-0000-4000-8000-000000000402";

test(
  "connect approval insert-time duplicate preserves the 409 and commits account usage",
  {
    skip: phase3DatabaseVerificationUrl()
      ? false
      : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async () => {
    const databaseUrl = phase3DatabaseVerificationUrl();
    assert.ok(databaseUrl);
    const accountId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const setupRequestId = crypto.randomUUID();
    const client = new pg.Client({
      application_name: "agent-outbox-connect-duplicate-verification",
      connectionString: databaseUrl
    });
    await client.connect();
    /** @type {unknown} */
    let bodyError;

    try {
      await assertMigrationOwnerCanSetAppRole(client);
      await client.query(
        `insert into public.agent_outbox_accounts(account_id, label) values ($1, $2)`,
        [accountId, `connect-duplicate-${accountId}`]
      );
      await client.query(
        `insert into public.agent_outbox_users(user_id, clerk_user_id) values ($1, $2)`,
        [userId, `connect-duplicate-${userId}`]
      );
      await client.query(
        `insert into public.agent_outbox_account_members(account_id, user_id, role) values ($1, $2, 'owner')`,
        [accountId, userId]
      );
      await client.query(
        `
          insert into public.agent_outbox_caller_setup_requests(
            setup_request_id, operation, flow, local_caller_name,
            display_name, callback_url, expires_at
          )
          values ($1, 'connect', 'browser', 'steward-email', 'Steward Email',
            'http://127.0.0.1:49152/callback', now() + interval '10 minutes')
        `,
        [setupRequestId]
      );

      let competingInsertCommitted = false;
      const result = await runProductTransaction(
        databaseUrl,
        {
          requestId: "req-connect-duplicate-db",
          authSurface: "human",
          accountId,
          userId
        },
        async (query) => {
          await query({ sql: "set local role agent_outbox_app" });
          return approveConnectBrowserSetupRequest(
            /**
             * @template {import("pg").QueryResultRow} TResult
             * @param {TransactionContextStatement} statement
             * @returns {Promise<import("pg").QueryResult<TResult>>}
             */
            async (statement) => {
              const queryResult = await query(statement);
              if (
                /from public\.agent_outbox_callers/.test(statement.sql) &&
                /caller_slug = \$2/.test(statement.sql)
              ) {
                assert.deepEqual(queryResult.rows, []);
                // Commit a competing insert after the real precheck, forcing
                // the approval INSERT (not the precheck) to hit PostgreSQL 23505.
                await client.query(
                  `
                    insert into public.agent_outbox_callers(
                      account_id, display_name, caller_slug
                    ) values ($1, 'Competing Caller', 'steward-email')
                  `,
                  [accountId]
                );
                competingInsertCommitted = true;
              }
              return /** @type {import("pg").QueryResult<TResult>} */ (
                queryResult
              );
            },
            { setupRequestId, accountId, userId }
          );
        }
      );

      assert.equal(competingInsertCommitted, true);
      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 409,
          code: "caller_already_exists",
          message:
            "A caller with this name already exists for this account. Use caller rotate or choose a different name.",
          fields: [
            {
              path: "local_caller_name",
              code: "duplicate",
              message:
                "A caller with this name already exists for this account."
            }
          ]
        }
      });
      const usage = await client.query(
        `
          select sum(used_units)::int as used_units
          from public.agent_outbox_account_quota_windows
          where account_id = $1
            and metric = 'caller_connect_approvals_per_account_per_minute'
        `,
        [accountId]
      );
      assert.deepEqual(usage.rows, [{ used_units: 1 }]);
      const setup = await client.query(
        `select status, caller_id from public.agent_outbox_caller_setup_requests where setup_request_id = $1`,
        [setupRequestId]
      );
      assert.deepEqual(setup.rows, [{ status: "pending", caller_id: null }]);
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          /** @type {Error[]} */
          const errors = [];
          const attempt = teardownAttempt(
            errors,
            "Connect duplicate teardown failed"
          );
          await attempt("setup request cleanup", () =>
            client.query(
              `delete from public.agent_outbox_caller_setup_requests where setup_request_id = $1`,
              [setupRequestId]
            )
          );
          await attempt("account cleanup", () =>
            client.query(
              `delete from public.agent_outbox_accounts where account_id = $1`,
              [accountId]
            )
          );
          await attempt("user cleanup", () =>
            client.query(
              `delete from public.agent_outbox_users where user_id = $1`,
              [userId]
            )
          );
          await attempt("client close", () => client.end());
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              "Connect duplicate teardown failed."
            );
          }
        },
        "Connect duplicate database test and teardown both failed."
      );
    }
  }
);

test(
  "revoke confirmed during connect activation waits for it and revokes the activated key",
  {
    skip: phase3DatabaseVerificationUrl()
      ? false
      : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async () => {
    const databaseUrl = phase3DatabaseVerificationUrl();
    assert.ok(databaseUrl);
    const accountId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const callerId = crypto.randomUUID();
    const connectSetupRequestId = crypto.randomUUID();
    const revokeSetupCode = `revoke-race-${crypto.randomUUID()}`;
    const clientIp = "198.51.100.73";
    const client = new pg.Client({
      application_name: "agent-outbox-connect-revoke-race-verification",
      connectionString: databaseUrl
    });
    await client.connect();
    const activateRequestId = `req-connect-revoke-race-activate-${accountId}`;
    const revokeRequestId = `req-connect-revoke-race-revoke-${accountId}`;
    /** @type {PromiseWithResolvers<number>} */
    const activationUpdated = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const resumeActivation = Promise.withResolvers();
    /** @type {Promise<unknown>[]} */
    const operations = [];
    /** @type {unknown} */
    let bodyError;

    try {
      await assertMigrationOwnerCanSetAppRole(client);
      await withProcessEnv(
        {
          CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
          DATABASE_APP_ROLE_URL: databaseUrl
        },
        async () => {
          const material = generateCallerApiKeyMaterial();
          await client.query(
            `insert into public.agent_outbox_accounts(account_id, label) values ($1, $2)`,
            [accountId, `connect-revoke-race-${accountId}`]
          );
          await client.query(
            `insert into public.agent_outbox_users(user_id, clerk_user_id) values ($1, $2)`,
            [userId, `connect-revoke-race-${userId}`]
          );
          await client.query(
            `insert into public.agent_outbox_account_members(account_id, user_id, role) values ($1, $2, 'owner')`,
            [accountId, userId]
          );
          await client.query(
            `
              insert into public.agent_outbox_callers(
                caller_id, account_id, display_name, caller_slug
              )
              values ($1, $2, 'Race Caller', 'race-caller')
            `,
            [callerId, accountId]
          );
          await client.query(
            `
              insert into public.agent_outbox_caller_setup_requests(
                setup_request_id, operation, flow, local_caller_name,
                display_name, callback_url, account_id, caller_id,
                approved_by_user_id, status, expires_at
              )
              values ($1, 'connect', 'browser', 'race-caller', 'Race Caller',
                'http://127.0.0.1:49152/callback', $2, $3, $4, 'exchanged',
                now() + interval '10 minutes')
            `,
            [connectSetupRequestId, accountId, callerId, userId]
          );
          await client.query(
            `
              insert into public.agent_outbox_caller_credentials(
                account_id, caller_id, key_id, key_prefix, key_last_four,
                secret_hmac_sha256, status, expires_at,
                pending_replacement_setup_request_id
              )
              values ($1, $2, $3, $4, $5, $6, 'pending_activation',
                now() + interval '10 minutes', $7)
            `,
            [
              accountId,
              callerId,
              material.keyId,
              material.keyPrefix,
              material.keyLastCharacters,
              material.secretDigest,
              connectSetupRequestId
            ]
          );
          await client.query(
            `
              insert into public.agent_outbox_caller_setup_requests(
                operation, flow, local_caller_name, display_name,
                callback_url, setup_code_hash, account_id, caller_id,
                approved_by_user_id, status, expires_at
              )
              values ('revoke', 'browser', 'race-caller', 'Race Caller',
                'http://127.0.0.1:49152/callback', $1, $2, $3, $4,
                'approved', now() + interval '10 minutes')
            `,
            [setupCodeDigest(revokeSetupCode), accountId, callerId, userId]
          );

          /** @type {typeof runProductTransaction} */
          const appRoleTransaction = (
            _connectionString,
            context,
            callback,
            options
          ) =>
            runProductTransaction(
              databaseUrl,
              context,
              async (query) => {
                await query({ sql: "set local role agent_outbox_app" });
                return callback(async (statement) => {
                  const result = await query(statement);
                  // Hold the activation transaction open after its UPDATE so
                  // revoke confirmation runs while activation is uncommitted.
                  if (
                    context.authSurface === "caller" &&
                    /status = 'active',\s+activated_at = now\(\)/.test(
                      statement.sql
                    )
                  ) {
                    const backend = await query({
                      sql: "select pg_backend_pid() as pid"
                    });
                    activationUpdated.resolve(backend.rows[0].pid);
                    await resumeActivation.promise;
                  }
                  return /** @type {any} */ (result);
                });
              },
              options
            );

          const activation = handleConnectActivateRequest(
            new Request(
              "https://app.agent-outbox.dev/api/caller/connect/activate",
              {
                headers: {
                  "cf-connecting-ip": clientIp,
                  authorization: `Bearer ${material.plaintextApiKey}`
                }
              }
            ),
            {
              requestId: activateRequestId,
              correlationId: "corr-connect-revoke-race-activate"
            },
            { setup_request_id: connectSetupRequestId },
            { runProductTransaction: appRoleTransaction }
          );
          operations.push(activation);
          const activationPid = await Promise.race([
            activationUpdated.promise,
            activation.then((result) =>
              assert.fail(
                `activation finished before its UPDATE paused: ${JSON.stringify(result)}`
              )
            )
          ]);

          const revoke = handleRevokeConfirmRequest(
            new Request(
              "https://app.agent-outbox.dev/api/caller/revoke/confirm",
              { headers: { "cf-connecting-ip": clientIp } }
            ),
            {
              requestId: revokeRequestId,
              correlationId: "corr-connect-revoke-race-revoke"
            },
            { setup_code: revokeSetupCode },
            { runProductTransaction: appRoleTransaction }
          );
          operations.push(revoke);
          let revokeBlocked = false;
          for (let attempt = 0; attempt < 60 && !revokeBlocked; attempt += 1) {
            const waiting = await client.query(
              `
                select exists (
                  select 1
                  from pg_stat_activity
                  where $1::int = any(pg_blocking_pids(pid))
                ) as blocked
              `,
              [activationPid]
            );
            revokeBlocked = waiting.rows[0].blocked;
            if (!revokeBlocked) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          resumeActivation.resolve();
          assert.equal(
            revokeBlocked,
            true,
            "revoke confirmation must wait on the uncommitted activation"
          );

          const [activated, revoked] = await Promise.all([activation, revoke]);
          assert.equal(activated.ok, true, JSON.stringify(activated));
          assert.equal(revoked.ok, true, JSON.stringify(revoked));
          assert.deepEqual(revoked.ok && revoked.data.revoked_key_ids, [
            material.keyId
          ]);
          const credential = await client.query(
            `select status from public.agent_outbox_caller_credentials where key_id = $1`,
            [material.keyId]
          );
          assert.deepEqual(credential.rows, [{ status: "revoked" }]);
        }
      );
    } catch (error) {
      bodyError = error;
    } finally {
      resumeActivation.resolve();
      await Promise.allSettled(operations);
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          /** @type {Error[]} */
          const errors = [];
          const attempt = teardownAttempt(
            errors,
            "Connect revoke race teardown failed"
          );
          await attempt("audit event cleanup", async () => {
            // Audit events are append-only outside break-glass cleanup.
            await client.query("begin");
            try {
              await client.query(
                "select set_config($1, $2, true), set_config($3, $4, true)",
                [
                  "agent_outbox.audit_break_glass",
                  "on",
                  "agent_outbox.auth_surface",
                  "cleanup"
                ]
              );
              await client.query(
                `delete from public.agent_outbox_audit_events where request_id = any($1::text[])`,
                [[activateRequestId, revokeRequestId]]
              );
              await client.query("commit");
            } catch (error) {
              await client.query("rollback");
              throw error;
            }
          });
          await attempt("IP quota cleanup", () =>
            client.query(
              `delete from public.agent_outbox_ip_quota_windows where ip_address = $1::inet`,
              [clientIp]
            )
          );
          await attempt("account cleanup", () =>
            client.query(
              `delete from public.agent_outbox_accounts where account_id = $1`,
              [accountId]
            )
          );
          await attempt("user cleanup", () =>
            client.query(
              `delete from public.agent_outbox_users where user_id = $1`,
              [userId]
            )
          );
          await attempt("client close", () => client.end());
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              "Connect revoke race teardown failed."
            );
          }
        },
        "Connect revoke race database test and teardown both failed."
      );
    }
  }
);

/**
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("./helpers/fake-query.mjs").MockProductTransactionQuery} MockProductTransactionQuery
 */

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
  const controlQuery = fakeSavepointAwareQuery((_statement, callNumber) => {
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
  const callerQuery = fakeSavepointAwareQuery((_statement, callNumber) => {
    // Call 1 is the caller credential lifecycle lock.
    if (callNumber === 2) {
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

test("browser connect start preserves Unicode text and returns approval metadata after the per-IP limit", async () => {
  await withProcessEnv(
    {
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000101";
      const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
          local_caller_name: "café-邮件-🚀",
          display_name: "Cafe\u0301 邮件 🚀",
          callback_url: "http://127.0.0.1:49152/邮件/🚀"
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
      assert.deepEqual(query.calls[1].values, [
        "connect",
        "browser",
        "café-邮件-🚀",
        "Cafe\u0301 邮件 🚀",
        "http://127.0.0.1:49152/邮件/🚀",
        null,
        null,
        null,
        "2026-07-02T00:10:00.000Z",
        5
      ]);
    }
  );
});

test("device connect start preserves Unicode text and stores only hashed device and user codes", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
          local_caller_name: "café-邮件-🚀",
          display_name: "Cafe\u0301 邮件 🚀"
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
      assert.deepEqual(query.calls[1].values?.slice(0, 5), [
        "connect",
        "device",
        "café-邮件-🚀",
        "Cafe\u0301 邮件 🚀",
        null
      ]);
      assert.equal(
        query.calls[1].values?.[5],
        setupCodeDigest(result.data.device_code)
      );
      assert.equal(
        query.calls[1].values?.[6],
        setupCodeDigest(result.data.user_code.replace(/[\s-]+/g, ""))
      );
      assert.match(String(query.calls[1].values?.[5]), /^[a-f0-9]{64}$/);
      assert.match(String(query.calls[1].values?.[6]), /^[a-f0-9]{64}$/);
      assert.deepEqual(query.calls[1].values?.slice(7), [
        null,
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
        const query = fakeSavepointAwareQuery(() => [{ used_units: "31" }]);
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

test("connect browser start preserves validation errors before transactions", async () => {
  await withProcessEnv(
    { PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev" },
    async () => {
      const cases = [
        {
          key: "callback_url",
          value: "https://127.0.0.1:1/cb",
          code: "invalid_callback_url",
          message: "callback_url must be an http localhost callback URL."
        },
        {
          key: "callback_url",
          value: "http://example.com/cb",
          code: "invalid_callback_url",
          message: "callback_url must be an http localhost callback URL."
        },
        {
          key: "callback_url",
          value: "not a url",
          code: "invalid_callback_url",
          message: "callback_url must be a valid URL."
        },
        {
          key: "local_caller_name",
          value: "x".repeat(129),
          code: "too_long",
          message: "local_caller_name must be at most 128 characters."
        },
        {
          key: "local_caller_name",
          value: undefined,
          code: "required",
          message: "local_caller_name is required."
        }
      ];
      for (const testCase of cases) {
        const label = `${testCase.key} ${testCase.value}`;
        /** @type {Record<string, unknown>} */
        const body = {
          display_name: "Steward Email",
          local_caller_name: "steward-email",
          callback_url: "http://127.0.0.1:49152/callback"
        };
        if (testCase.value === undefined) {
          delete body[testCase.key];
        } else {
          body[testCase.key] = testCase.value;
        }
        const runner = fakeTransactionRunner([]);
        const result = await handleConnectBrowserStartRequest(
          connectRequest("/api/caller/connect/browser/start"),
          {
            requestId: "req-browser-validation",
            correlationId: "corr-browser-validation"
          },
          body,
          { runProductTransaction: runner.runProductTransaction }
        );
        assert.deepEqual(
          result,
          {
            ok: false,
            error: {
              status: 422,
              code: "validation_failed",
              message: "Caller connect request failed validation.",
              fields: [
                {
                  path: testCase.key,
                  code: testCase.code,
                  message: testCase.message
                }
              ]
            }
          },
          label
        );
        assert.equal(runner.contexts.length, 0, label);
      }
    }
  );
});

test("connect browser start rejects missing public app URL before transactions", async () => {
  await withProcessEnv({ PUBLIC_APP_BASE_URL: undefined }, async () => {
    const runner = fakeTransactionRunner([]);
    const result = await handleConnectBrowserStartRequest(
      connectRequest("/api/caller/connect/browser/start"),
      {
        requestId: "req-browser-missing-url",
        correlationId: "corr-browser-missing-url"
      },
      {
        display_name: "Steward Email",
        local_caller_name: "steward-email",
        callback_url: "http://127.0.0.1:49152/callback"
      },
      { runProductTransaction: runner.runProductTransaction }
    );
    assert.deepEqual(result, {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Public app base URL configuration is unavailable."
      }
    });
    assert.equal(runner.contexts.length, 0);
  });
});

test("connect rejects text Postgres cannot store before transactions", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev"
    },
    async () => {
      const routes = [
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
        },
        {
          name: "device poll",
          handler: handleConnectDevicePollRequest,
          path: "/api/caller/connect/device/poll",
          body: { device_code: "dev_pending" }
        },
        {
          name: "exchange",
          handler: handleConnectExchangeRequest,
          path: "/api/caller/connect/exchange",
          body: { setup_code: "setup_pending" }
        }
      ];

      for (const route of routes) {
        for (const [key, validValue] of Object.entries(route.body)) {
          for (const invalid of ["\u0000", "\ud800", "\udc00"]) {
            const value = `${validValue}${invalid}text`;
            const label = `${route.name} ${key} ${JSON.stringify(value)}`;
            const runner = fakeTransactionRunner([]);
            const result = await route.handler(
              connectRequest(route.path),
              {
                requestId: `req-${route.name}-unstorable`,
                correlationId: `corr-${route.name}-unstorable`
              },
              {
                ...route.body,
                [key]: value
              },
              { runProductTransaction: runner.runProductTransaction }
            );

            assert.equal(result.ok, false, label);
            if (result.ok) {
              assert.fail(`expected ${label} to fail validation`);
            }
            assert.equal(result.error.status, 422, label);
            assert.equal(result.error.code, "validation_failed", label);
            assert.deepEqual(
              result.error.fields,
              [
                {
                  path: key,
                  code: "invalid_string",
                  message: `${key} must be well-formed Unicode without NUL characters.`
                }
              ],
              label
            );
            assert.equal(runner.contexts.length, 0, label);
          }
        }
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
      const query = fakeSavepointAwareQuery(() => [
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
      const query = fakeSavepointAwareQuery(() => [
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

      const result = await getSetupRequestTerminalState(query, {
        operation: "connect",
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
      assert.match(query.calls[0].sql, /setup\.status in \(\$4, \$5\)/);
      assert.deepEqual(query.calls[0].values, [
        setupRequestId,
        ACCOUNT_ID,
        "connect",
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
      const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
      assert.deepEqual(query.calls[0].values, [setupCodeDigest("ABCD2345")]);
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
      const query = fakeSavepointAwareQuery(() => [
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
      const query = fakeSavepointAwareQuery(() => [
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
      const query = fakeSavepointAwareQuery(() => [
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
      const query = fakeSavepointAwareQuery(() => []);

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
      const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
      assert.equal(
        query.calls[6].values?.[4],
        setupCodeDigest(result.data.setup_code)
      );
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
      const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
        USER_ID,
        null
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
        const query = fakeSavepointAwareQuery(() => [
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
      const query = fakeSavepointAwareQuery(() => [
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
  // The setup-code digest needs the hash secret; leaving it unset proves the
  // rejection happens before the setup code is hashed.
  await withProcessEnv({ CALLER_KEY_HASH_SECRET: undefined }, async () => {
    const setupRequestId = "10000000-0000-4000-8000-000000000011";
    const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
  });
});

test("device approval rejects a duplicate caller name before caller creation", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000012";
      const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
  // The setup-code digest needs the hash secret; leaving it unset proves the
  // rejection happens before the setup code is hashed.
  await withProcessEnv({ CALLER_KEY_HASH_SECRET: undefined }, async () => {
    const setupRequestId = "10000000-0000-4000-8000-000000000004";
    const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
  });
});

test("connect exchange mints only a pending credential without activating, revoking, or auditing", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const setupRequestId = "10000000-0000-4000-8000-000000000001";
      const query = fakeSavepointAwareQuery((statement, callNumber) => {
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
      const controlQuery = fakeSavepointAwareQuery((_statement, callNumber) => {
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
      const controlQuery = fakeSavepointAwareQuery((_statement, callNumber) => {
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
      const humanQuery = fakeSavepointAwareQuery((statement, callNumber) => {
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
        const controlQuery = fakeSavepointAwareQuery(
          (_statement, callNumber) => {
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
          }
        );
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
        assert.equal(controlQuery.calls.length, 2, status);
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
        const query = fakeSavepointAwareQuery((_statement, callNumber) => {
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
  /** @type {{ operationKind: Parameters<typeof enforceIpControlPlaneLimit>[2], limitName: string }[]} */
  const cases = [
    {
      operationKind: "caller_connect_start",
      limitName: "caller_connect_start_requests_per_ip_per_minute"
    },
    {
      operationKind: "caller_connect_poll",
      limitName: "caller_connect_poll_requests_per_ip_per_minute"
    },
    {
      operationKind: "caller_connect_exchange",
      limitName: "caller_connect_exchange_requests_per_ip_per_minute"
    }
  ];

  for (const { operationKind, limitName } of cases) {
    const query = fakeSavepointAwareQuery(() => [{ used_units: "31" }]);

    const result = await enforceIpControlPlaneLimit(
      query,
      "203.0.113.9",
      operationKind
    );

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
      const controlQuery = fakeSavepointAwareQuery(() => [
        { used_units: "31" }
      ]);
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
      const controlQuery = fakeSavepointAwareQuery(() => [
        { used_units: "31" }
      ]);
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

test("connect activate and abort IP denial stops before credential lookup and caller transaction", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const material = generateCallerApiKeyMaterial();
      for (const handler of [
        handleConnectActivateRequest,
        handleConnectAbortRequest
      ]) {
        const query = fakeSavepointAwareQuery(() => [{ used_units: "31" }]);
        const runner = fakeTransactionRunner([query]);
        const result = await handler(
          connectRequest("/pending", {
            headers: { authorization: `Bearer ${material.plaintextApiKey}` }
          }),
          {
            requestId: "req-pending-limit",
            correlationId: "corr-pending-limit"
          },
          { setup_request_id: SETUP_REQUEST_ID },
          { runProductTransaction: runner.runProductTransaction }
        );
        assert.equal(result.ok, false);
        if (result.ok) assert.fail("expected pending connect IP denial");
        assert.equal(result.error.status, 429);
        assert.equal(result.error.code, "rate_limit_exceeded");
        assert.ok(result.error.limit && "limitName" in result.error.limit);
        assert.equal(
          result.error.limit.limitName,
          "caller_connect_activation_requests_per_ip_per_minute"
        );
        assert.equal(query.calls.length, 1);
        assert.deepEqual(query.calls[0].values?.slice(0, 3), [
          CONNECT_TEST_IP,
          "caller_connect_activation_requests_per_ip_per_minute",
          "minute"
        ]);
        assert.equal(runner.contexts.length, 1);
        assert.equal(runner.contexts[0].authSurface, "control_plane");
      }
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
      // Activation serializes with revoke and rotate on the caller's lifecycle
      // lock before it locks the pending credential row.
      assert.match(callerQuery.calls[0].sql, /caller_credential_lifecycle/);
      assert.deepEqual(callerQuery.calls[0].values, [ACCOUNT_ID, CALLER_ID]);
      // The pending credential is resolved by the bearer key AND its setup
      // request, never by setup request alone.
      assert.match(
        callerQuery.calls[1].sql,
        /pending_replacement_setup_request_id = \$2/
      );
      assert.deepEqual(callerQuery.calls[1].values, [
        material.keyId,
        SETUP_REQUEST_ID
      ]);
      assert.match(callerQuery.calls[2].sql, /status = 'active'/);
      // The activation UPDATE is guarded to the pending_activation state, so a
      // regression dropping the guard (allowing an already-active or otherwise
      // non-pending row to be re-activated) fails here.
      assert.match(callerQuery.calls[2].sql, /status = 'pending_activation'/);
      assert.match(callerQuery.calls[3].sql, /'caller_registered'/);
      // Connect has no prior credential, so activation revokes nothing.
      const mutationSql = callerQuery.calls
        .slice(2)
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
      // Abort serializes with revoke and rotate on the caller's lifecycle
      // lock before it locks the pending credential row.
      assert.match(callerQuery.calls[0].sql, /caller_credential_lifecycle/);
      assert.deepEqual(callerQuery.calls[0].values, [ACCOUNT_ID, CALLER_ID]);
      assert.match(callerQuery.calls[2].sql, /status = 'expired'/);
      // The expire UPDATE is guarded to the pending_activation state so abort
      // can never expire an already-active credential; dropping the guard fails
      // this assertion.
      assert.match(callerQuery.calls[2].sql, /status = 'pending_activation'/);
      assert.match(
        callerQuery.calls[2].sql,
        /pending_replacement_setup_request_id = null/
      );
      const mutationSql = callerQuery.calls
        .slice(2)
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
        assert.match(callerQuery.calls[2].sql, /status = 'expired'/);
        assert.doesNotMatch(
          callerQuery.calls[2].sql,
          /pending_replacement_for_credential_id = null/
        );
        assert.match(
          callerQuery.calls[2].sql,
          /pending_replacement_setup_request_id = null/
        );
        const mutationSql = callerQuery.calls
          .slice(2)
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
        // runs, so only the lifecycle lock and SELECT executed inside the
        // caller transaction.
        assert.equal(callerQuery.calls.length, 2, action);
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
        assert.equal(callerQuery.calls.length, 2, action);
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

test("browser approval pages and actions reject a malformed setup_request_id before querying", async () => {
  const uppercaseSetupRequestId = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
  /** @type {{ name: string, run: (query: MockProductTransactionQuery, setupRequestId: string) => Promise<{ ok: true } | { ok: false, error: { status: number, code: string, message: string } }> }[]} */
  const cases = [
    {
      name: "approval preview",
      run: (query, setupRequestId) =>
        getConnectBrowserApprovalPreview(query, { setupRequestId })
    },
    {
      name: "terminal state",
      run: (query, setupRequestId) =>
        getSetupRequestTerminalState(query, {
          operation: "connect",
          setupRequestId,
          accountId: ACCOUNT_ID,
          statuses: ["denied"]
        })
    },
    {
      name: "approve",
      run: (query, setupRequestId) =>
        approveConnectBrowserSetupRequest(query, {
          setupRequestId,
          accountId: ACCOUNT_ID,
          userId: USER_ID
        })
    },
    {
      name: "deny",
      run: (query, setupRequestId) =>
        denyConnectSetupRequest(query, {
          setupRequestId,
          accountId: ACCOUNT_ID
        })
    }
  ];

  for (const testCase of cases) {
    // Postgres rejects these as uuid input, so they must never reach SQL.
    for (const setupRequestId of [
      "not-a-uuid",
      SETUP_REQUEST_ID.slice(0, -1),
      `${SETUP_REQUEST_ID}'`
    ]) {
      const query = fakeSavepointAwareQuery(() => {
        throw new Error("malformed setup_request_id must not reach SQL");
      });
      const result = await testCase.run(query, setupRequestId);

      assert.deepEqual(
        result,
        {
          ok: false,
          error: {
            status: 400,
            code: "invalid_request",
            message: "Invalid setup request."
          }
        },
        `${testCase.name}: ${setupRequestId}`
      );
      assert.equal(query.calls.length, 0, testCase.name);
    }

    // An uppercase UUID is valid uuid input and must still be looked up.
    const query = fakeSavepointAwareQuery(() => []);
    const result = await testCase.run(query, uppercaseSetupRequestId);
    assert.equal(result.ok, false, testCase.name);
    if (result.ok) {
      assert.fail(`expected unknown ${testCase.name} setup request to fail`);
    }
    assert.equal(result.error.code, "not_found", testCase.name);
    assert.deepEqual(
      query.calls[0]?.values?.[0],
      uppercaseSetupRequestId,
      testCase.name
    );
  }
});

test("connect pending handlers preserve validation, authentication, availability and failure reports", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const context = {
        requestId: "req-pending-contract",
        correlationId: "corr-pending-contract"
      };
      const body = { setup_request_id: SETUP_REQUEST_ID };
      const authorization = `Bearer ${material.plaintextApiKey}`;
      const handlers = [
        {
          handler: handleConnectActivateRequest,
          ipMessage:
            "Trusted client IP is unavailable for caller connect activation.",
          lookupOperation: "caller_connect_activate_lookup",
          operation: "caller_connect_activate"
        },
        {
          handler: handleConnectAbortRequest,
          ipMessage:
            "Trusted client IP is unavailable for caller connect abort.",
          lookupOperation: "caller_connect_abort_lookup",
          operation: "caller_connect_abort"
        }
      ];
      for (const entry of handlers) {
        const request = (headers = { authorization }) =>
          connectRequest("/api/caller/connect/activate", { headers });
        for (const invalidBody of [null, []]) {
          assert.deepEqual(
            await entry.handler(request(), context, invalidBody),
            {
              ok: false,
              error: {
                status: 422,
                code: "validation_failed",
                message: "Caller connect request failed validation.",
                fields: [
                  {
                    path: "",
                    code: "invalid_request",
                    message: "Request body must be an object."
                  }
                ]
              }
            }
          );
        }
        assert.deepEqual(
          await entry.handler(request({ authorization: "" }), context, body),
          {
            ok: false,
            error: {
              status: 401,
              code: "authentication_required",
              message: "Pending connect bearer credential is required."
            }
          }
        );
        assert.deepEqual(
          await entry.handler(
            request({ authorization: "Bearer malformed" }),
            context,
            body
          ),
          {
            ok: false,
            error: {
              status: 401,
              code: "invalid_caller_credentials",
              message:
                "Pending connect credential is invalid or no longer usable."
            }
          }
        );
        assert.deepEqual(
          await entry.handler(
            connectRequest("/api/caller/connect/activate", {
              headers: { authorization, "cf-connecting-ip": "" }
            }),
            context,
            body
          ),
          {
            ok: false,
            error: {
              status: 503,
              code: "temporary_unavailable",
              message: entry.ipMessage
            }
          }
        );
        await withProcessEnv({ DATABASE_APP_ROLE_URL: undefined }, async () => {
          assert.deepEqual(await entry.handler(request(), context, body), {
            ok: false,
            error: {
              status: 503,
              code: "temporary_unavailable",
              message: "Caller connect database configuration is unavailable."
            }
          });
        });
        for (const failAt of [1, 2]) {
          const { controlQuery } = pendingConnectRunner(material);
          let calls = 0;
          /** @type {typeof import("../src/server/database.ts").runProductTransaction} */
          const runProductTransaction = async (_url, _context, callback) => {
            calls += 1;
            if (calls === failAt)
              throw new Error("injected transaction failure");
            return callback(controlQuery);
          };
          /** @type {string[]} */
          const lines = [];
          const originalError = console.error;
          let result;
          try {
            console.error = (line) => lines.push(line);
            result = await entry.handler(request(), context, body, {
              runProductTransaction
            });
          } finally {
            console.error = originalError;
          }
          assert.equal(calls, failAt);
          assert.deepEqual(result, {
            ok: false,
            error: {
              status: 503,
              code: "temporary_unavailable",
              message: "Caller connect is temporarily unavailable.",
              errorId: context.correlationId,
              reported: true
            }
          });
          assert.equal(lines.length, 1);
          const log = JSON.parse(lines[0]);
          assert.equal(
            log.operation,
            failAt === 1 ? entry.lookupOperation : entry.operation
          );
          assert.equal(
            log.message,
            "Caller connect request failed unexpectedly."
          );
          assert.equal(log.error_id, context.correlationId);
          assert.equal(log.request_id, context.requestId);
          assert.equal(log.surface, "api");
          assert.equal(log.status_code, 503);
          assert.equal(log.account_id, failAt === 1 ? undefined : ACCOUNT_ID);
          assert.equal(log.caller_id, failAt === 1 ? undefined : CALLER_ID);
        }
      }
    }
  );
});

test("connect approved-code handlers preserve availability and transaction failure contracts", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const context = {
        requestId: "req-approved-contract",
        correlationId: "corr-approved-contract"
      };
      const now = new Date("2026-07-02T00:00:00.000Z");
      const handlers = [
        {
          handler: handleConnectExchangeRequest,
          field: "setup_code",
          flow: "browser",
          ipMessage:
            "Trusted client IP is unavailable for caller connect exchange.",
          lookupOperation: "caller_connect_exchange_lookup",
          exchangeOperation: "caller_connect_exchange"
        },
        {
          handler: handleConnectDevicePollRequest,
          field: "device_code",
          flow: "device",
          ipMessage:
            "Trusted client IP is unavailable for caller connect poll.",
          lookupOperation: "caller_connect_device_poll",
          exchangeOperation: "caller_connect_exchange"
        }
      ];
      for (const entry of handlers) {
        const body = { [entry.field]: "approved_code" };
        const request = (headers = {}) => connectRequest("/code", { headers });
        assert.deepEqual(
          await entry.handler(
            request({ "cf-connecting-ip": "" }),
            context,
            body,
            { now }
          ),
          {
            ok: false,
            error: {
              status: 503,
              code: "temporary_unavailable",
              message: entry.ipMessage
            }
          }
        );
        // Connect hashes the code before the trusted-IP check, so hash-secret
        // configuration errors still surface when the IP is unavailable.
        for (const [secret, errorName] of [
          [undefined, "MissingServerEnvironmentError"],
          ["too-short", "InsecureServerEnvironmentError"]
        ]) {
          await withProcessEnv({ CALLER_KEY_HASH_SECRET: secret }, async () => {
            await assert.rejects(
              entry.handler(
                request({ "cf-connecting-ip": "" }),
                context,
                body,
                {
                  now
                }
              ),
              { name: errorName }
            );
          });
        }
        await withProcessEnv({ DATABASE_APP_ROLE_URL: undefined }, async () => {
          assert.deepEqual(
            await entry.handler(request(), context, body, { now }),
            {
              ok: false,
              error: {
                status: 503,
                code: "temporary_unavailable",
                message: "Caller connect database configuration is unavailable."
              }
            }
          );
        });
        // failAt 1 throws before the lookup transaction callback, so neither
        // the IP-limit query nor the lookup query runs. failAt 2 runs the first
        // transaction: its first query returns the IP-limit result and its
        // second returns the approved lookup row. The exchange transaction
        // then fails on its first query. The fake runner does not exercise
        // real PostgreSQL row locks or rollback.
        for (const failAt of [1, 2]) {
          const controlQuery = fakeSavepointAwareQuery(
            (_statement, callNumber) =>
              callNumber === 1
                ? [{ used_units: "1" }]
                : [
                    {
                      setup_request_id: SETUP_REQUEST_ID,
                      status: "approved",
                      account_id: ACCOUNT_ID,
                      approved_by_user_id: USER_ID,
                      poll_interval_seconds: 5,
                      expires_at: "2026-07-02T00:10:00.000Z"
                    }
                  ]
          );
          const humanQuery = fakeSavepointAwareQuery(() => {
            throw new Error("injected exchange query failure");
          });
          const runner = fakeTransactionRunner([controlQuery, humanQuery]);
          let calls = 0;
          /** @type {typeof import("../src/server/database.ts").runProductTransaction} */
          const runProductTransaction = async (
            url,
            transactionContext,
            callback
          ) => {
            calls += 1;
            if (failAt === 1)
              throw new Error("injected lookup transaction failure");
            return runner.runProductTransaction(
              url,
              transactionContext,
              callback
            );
          };
          /** @type {string[]} */
          const lines = [];
          const originalError = console.error;
          let result;
          try {
            console.error = (line) => lines.push(line);
            result = await entry.handler(request(), context, body, {
              now,
              runProductTransaction
            });
          } finally {
            console.error = originalError;
          }
          assert.equal(calls, failAt);
          assert.deepEqual(result, {
            ok: false,
            error: {
              status: 503,
              code: "temporary_unavailable",
              message:
                failAt === 1
                  ? "Caller connect is temporarily unavailable."
                  : "Caller connect exchange is temporarily unavailable.",
              errorId: context.correlationId,
              reported: true
            }
          });
          assert.equal(lines.length, 1);
          const log = JSON.parse(lines[0]);
          assert.equal(
            log.operation,
            failAt === 1 ? entry.lookupOperation : entry.exchangeOperation
          );
          assert.equal(
            log.message,
            failAt === 1
              ? "Caller connect request failed unexpectedly."
              : "Caller connect exchange failed unexpectedly."
          );
          assert.equal(log.error_id, context.correlationId);
          assert.equal(log.request_id, context.requestId);
          assert.equal(log.surface, "api");
          assert.equal(log.status_code, 503);
          assert.equal(log.account_id, failAt === 1 ? undefined : ACCOUNT_ID);
          assert.equal(log.caller_id, undefined);
          if (failAt === 2) {
            assert.equal(controlQuery.calls.length, 2);
            assert.deepEqual(runner.contexts[0], {
              requestId: context.requestId,
              authSurface: "control_plane"
            });
            assert.deepEqual(runner.contexts[1], {
              requestId: context.requestId,
              authSurface: "human",
              accountId: ACCOUNT_ID,
              userId: USER_ID
            });
            const lookup = controlQuery.calls[1];
            assert.doesNotMatch(lookup.sql, /for update/i);
            assert.equal(humanQuery.calls.length, 1);
            const exchange = humanQuery.calls[0];
            assert.match(exchange.sql, /for update/i);
            assert.match(
              lookup.sql,
              entry.flow === "browser"
                ? /setup_code_hash = \$1/
                : /device_code_hash = \$1/
            );
            assert.match(lookup.sql, /operation = 'connect'/);
            assert.match(lookup.sql, new RegExp(`flow = '${entry.flow}'`));
            assert.match(
              exchange.sql,
              entry.flow === "browser"
                ? /setup\.setup_code_hash = \$1/
                : /setup\.device_code_hash = \$1/
            );
            assert.match(exchange.sql, /setup\.operation = 'connect'/);
            assert.match(
              exchange.sql,
              new RegExp(`setup\\.flow = '${entry.flow}'`)
            );
            assert.deepEqual(exchange.values, lookup.values);
          }
        }
      }
    }
  );
});

test("connect approved-code lookup outcomes stop after one transaction", async () => {
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db"
    },
    async () => {
      const now = new Date("2026-07-02T00:00:00.000Z");
      const approvedRow = {
        setup_request_id: SETUP_REQUEST_ID,
        status: "approved",
        account_id: ACCOUNT_ID,
        approved_by_user_id: USER_ID,
        poll_interval_seconds: 5,
        expires_at: "2026-07-02T00:10:00.000Z"
      };
      const cases = [
        {
          name: "no row",
          rows: [],
          expired: false,
          status: 400,
          message: "invalid or expired."
        },
        ...["pending", "approved"].map((status) => ({
          name: `expired ${status}`,
          rows: [
            { ...approvedRow, status, expires_at: "2026-07-01T23:59:59.000Z" }
          ],
          expired: true,
          status: 400,
          message: "invalid or expired."
        })),
        {
          name: "exchanged",
          rows: [{ ...approvedRow, status: "exchanged" }],
          expired: false,
          status: 400,
          message: "invalid or already used."
        },
        ...["account_id", "approved_by_user_id"].map((field) => ({
          name: `missing ${field}`,
          rows: [{ ...approvedRow, [field]: null }],
          expired: false,
          status: 503,
          message: "Caller connect approval is temporarily unavailable."
        }))
      ];
      for (const entry of [
        {
          handler: handleConnectExchangeRequest,
          field: "setup_code",
          noun: "Setup"
        },
        {
          handler: handleConnectDevicePollRequest,
          field: "device_code",
          noun: "Device"
        }
      ]) {
        for (const testCase of cases) {
          const query = fakeSavepointAwareQuery((_statement, callNumber) =>
            callNumber === 1
              ? [{ used_units: "1" }]
              : callNumber === 2
                ? testCase.rows
                : []
          );
          const runner = fakeTransactionRunner([query]);
          const result = await entry.handler(
            connectRequest("/code"),
            {
              requestId: "req-lookup-contract",
              correlationId: "corr-lookup-contract"
            },
            { [entry.field]: "lookup_code" },
            { now, runProductTransaction: runner.runProductTransaction }
          );
          assert.deepEqual(
            result,
            {
              ok: false,
              error: {
                status: testCase.status,
                code:
                  testCase.status === 400
                    ? "invalid_request"
                    : "temporary_unavailable",
                message:
                  testCase.status === 400
                    ? `${entry.noun} code is ${testCase.message}`
                    : testCase.message
              }
            },
            `${entry.noun}: ${testCase.name}`
          );
          assert.equal(runner.contexts.length, 1);
          assert.equal(query.calls.length, testCase.expired ? 3 : 2);
          if (testCase.expired) {
            assert.match(
              query.calls[2].sql,
              /update public\.agent_outbox_caller_setup_requests/
            );
            assert.match(query.calls[2].sql, /set\s+status = 'expired'/);
            assert.deepEqual(query.calls[2].values, [SETUP_REQUEST_ID]);
          }
        }
      }
    }
  );
});

test("connect parsers preserve ordered fields and the 512-character code limit", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const context = {
        requestId: "req-parser-contract",
        correlationId: "corr-parser-contract"
      };
      assert.deepEqual(
        await handleConnectBrowserStartRequest(
          connectRequest("/start"),
          context,
          {}
        ),
        {
          ok: false,
          error: {
            status: 422,
            code: "validation_failed",
            message: "Caller connect request failed validation.",
            fields: [
              {
                path: "local_caller_name",
                code: "required",
                message: "local_caller_name is required."
              },
              {
                path: "display_name",
                code: "required",
                message: "display_name is required."
              },
              {
                path: "callback_url",
                code: "required",
                message: "callback_url is required."
              }
            ]
          }
        }
      );
      const routes = [
        {
          handler: handleConnectDevicePollRequest,
          field: "device_code",
          ipMessage:
            "Trusted client IP is unavailable for caller connect poll.",
          tooLongMessage: "device_code must be at most 512 characters."
        },
        {
          handler: handleConnectExchangeRequest,
          field: "setup_code",
          ipMessage:
            "Trusted client IP is unavailable for caller connect exchange.",
          tooLongMessage: "setup_code must be at most 512 characters."
        }
      ];
      for (const route of routes) {
        const request = connectRequest("/code", {
          headers: { "cf-connecting-ip": "" }
        });
        for (const length of [200, 512]) {
          assert.deepEqual(
            await route.handler(request, context, {
              [route.field]: "x".repeat(length)
            }),
            {
              ok: false,
              error: {
                status: 503,
                code: "temporary_unavailable",
                message: route.ipMessage
              }
            }
          );
        }
        assert.deepEqual(
          await route.handler(request, context, {
            [route.field]: "x".repeat(513)
          }),
          {
            ok: false,
            error: {
              status: 422,
              code: "validation_failed",
              message: "Caller connect request failed validation.",
              fields: [
                {
                  path: route.field,
                  code: "too_long",
                  message: route.tooLongMessage
                }
              ]
            }
          }
        );
      }
    }
  );
});

// Expected errors follow the caller control-plane contracts in docs/spec/http-api.md
// and the field-error shape in docs/spec/errors.md.
const CONNECT_VALIDATION = "Caller connect request failed validation.";
const OPERATION_VALIDATION =
  "Caller credential operation request failed validation.";

/** @param {string} message @param {string} path @param {string} code @param {string} fieldMessage */
function validationFailure(message, path, code, fieldMessage) {
  return {
    ok: false,
    error: {
      status: 422,
      code: "validation_failed",
      message,
      fields: [{ path, code, message: fieldMessage }]
    }
  };
}

const CODE_BODY_HANDLERS = [
  {
    name: "connect poll",
    handler: handleConnectDevicePollRequest,
    field: "device_code",
    validation: CONNECT_VALIDATION,
    ipMessage: "Trusted client IP is unavailable for caller connect poll."
  },
  {
    name: "connect exchange",
    handler: handleConnectExchangeRequest,
    field: "setup_code",
    validation: CONNECT_VALIDATION,
    ipMessage: "Trusted client IP is unavailable for caller connect exchange."
  },
  {
    name: "rotate poll",
    handler: handleRotateDevicePollRequest,
    field: "device_code",
    validation: OPERATION_VALIDATION,
    ipMessage: "Trusted client IP is unavailable for caller rotate poll."
  },
  {
    name: "rotate exchange",
    handler: handleRotateExchangeRequest,
    field: "setup_code",
    validation: OPERATION_VALIDATION,
    ipMessage: "Trusted client IP is unavailable for caller rotate exchange."
  },
  {
    name: "revoke poll",
    handler: handleRevokeDevicePollRequest,
    field: "device_code",
    validation: OPERATION_VALIDATION,
    ipMessage: "Trusted client IP is unavailable for caller revoke poll."
  },
  {
    name: "revoke confirm",
    handler: handleRevokeConfirmRequest,
    field: "setup_code",
    validation: OPERATION_VALIDATION,
    ipMessage:
      "Trusted client IP is unavailable for caller revoke confirmation."
  }
];

const SETUP_REQUEST_ID_HANDLERS = [
  {
    name: "connect activate",
    handler: handleConnectActivateRequest,
    validation: CONNECT_VALIDATION,
    bearerMessage: "Pending connect bearer credential is required."
  },
  {
    name: "connect abort",
    handler: handleConnectAbortRequest,
    validation: CONNECT_VALIDATION,
    bearerMessage: "Pending connect bearer credential is required."
  },
  {
    name: "rotate activate",
    handler: handleRotateActivateRequest,
    validation: OPERATION_VALIDATION,
    bearerMessage: "Pending replacement bearer credential is required."
  },
  {
    name: "rotate abort",
    handler: handleRotateAbortRequest,
    validation: OPERATION_VALIDATION,
    bearerMessage: "Pending replacement bearer credential is required."
  }
];

test("setup code handlers reject non-object bodies and missing codes, and accept trimmed codes", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const context = {
        requestId: "req-body-contract",
        correlationId: "corr-body-contract"
      };
      for (const route of CODE_BODY_HANDLERS) {
        for (const body of [null, [], "text"]) {
          assert.deepEqual(
            await route.handler(connectRequest("/code"), context, body),
            validationFailure(
              route.validation,
              "",
              "invalid_request",
              "Request body must be an object."
            ),
            route.name
          );
        }
        for (const body of [
          {},
          { [route.field]: "   " },
          { [route.field]: 7 }
        ]) {
          assert.deepEqual(
            await route.handler(connectRequest("/code"), context, body),
            validationFailure(
              route.validation,
              route.field,
              "required",
              `${route.field} is required.`
            ),
            route.name
          );
        }
        // A padded code passes validation and reaches the trusted-IP check.
        assert.deepEqual(
          await route.handler(
            connectRequest("/code", { headers: { "cf-connecting-ip": "" } }),
            context,
            { [route.field]: "  code_x  " }
          ),
          {
            ok: false,
            error: {
              status: 503,
              code: "temporary_unavailable",
              message: route.ipMessage
            }
          },
          route.name
        );
      }
    }
  );
});

test("setup_request_id handlers reject non-object bodies and malformed IDs before requiring the bearer", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const context = {
        requestId: "req-body-contract",
        correlationId: "corr-body-contract"
      };
      for (const route of SETUP_REQUEST_ID_HANDLERS) {
        for (const body of [null, [], "text"]) {
          assert.deepEqual(
            await route.handler(connectRequest("/pending"), context, body),
            validationFailure(
              route.validation,
              "",
              "invalid_request",
              "Request body must be an object."
            ),
            route.name
          );
        }
        assert.deepEqual(
          await route.handler(connectRequest("/pending"), context, {
            setup_request_id: "not-a-uuid"
          }),
          validationFailure(
            route.validation,
            "setup_request_id",
            "invalid_uuid",
            "setup_request_id must be a UUID-formatted string."
          ),
          route.name
        );
        assert.deepEqual(
          await route.handler(connectRequest("/pending"), context, {
            setup_request_id: SETUP_REQUEST_ID
          }),
          {
            ok: false,
            error: {
              status: 401,
              code: "authentication_required",
              message: route.bearerMessage
            }
          },
          route.name
        );
      }
    }
  );
});

test("setup poll transaction-open failures report the exact unscoped log", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const polls = [
    {
      operation: "connect",
      handler: handleConnectDevicePollRequest,
      temporarilyUnavailable: "Caller connect is temporarily unavailable.",
      unexpectedFailure: "Caller connect request failed unexpectedly."
    },
    {
      operation: "rotate",
      handler: handleRotateDevicePollRequest,
      temporarilyUnavailable:
        "Caller credential operation is temporarily unavailable.",
      unexpectedFailure: "Caller credential operation failed unexpectedly."
    },
    {
      operation: "revoke",
      handler: handleRevokeDevicePollRequest,
      temporarilyUnavailable:
        "Caller credential operation is temporarily unavailable.",
      unexpectedFailure: "Caller credential operation failed unexpectedly."
    }
  ];
  await withProcessEnv(
    {
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
      DATABASE_APP_ROLE_URL: "postgresql://agent_outbox_app:test@example/db",
      APP_ENV: undefined,
      SENTRY_RELEASE: undefined,
      GITHUB_SHA: undefined
    },
    async () => {
      const context = {
        requestId: "req-poll-open",
        correlationId: "corr-poll-open"
      };
      for (const poll of polls) {
        log.mock.resetCalls();
        let calls = 0;
        assert.deepEqual(
          await poll.handler(
            connectRequest(`/api/caller/${poll.operation}/device/poll`),
            context,
            { device_code: "dev_x" },
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
              message: poll.temporarilyUnavailable,
              errorId: context.correlationId,
              reported: true
            }
          }
        );
        assert.equal(calls, 1);
        assert.deepEqual(
          log.mock.calls.map(({ arguments: args }) => args),
          [
            [
              JSON.stringify({
                environment: null,
                release: null,
                surface: "api",
                status_code: 503,
                operation: `caller_${poll.operation}_device_poll`,
                message: poll.unexpectedFailure,
                request_id: context.requestId,
                level: "error",
                error_id: context.correlationId,
                error_name: "Error",
                sentry_captured: false
              })
            ]
          ]
        );
      }
    }
  );
});
