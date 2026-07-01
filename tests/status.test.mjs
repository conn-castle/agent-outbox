import assert from "node:assert/strict";
import test from "node:test";

import {
  accountStatusInTransaction,
  callerStatusInTransaction,
  storageStatusStatement
} from "../src/server/status.ts";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

const identity = {
  accountId: "00000000-0000-4000-8000-000000000001",
  callerId: "00000000-0000-4000-8000-000000000002"
};

/**
 * @param {QueryResultRow[][]} rowsByCall
 * @returns {MockProductTransactionQuery}
 */
function fakeQuery(rowsByCall) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /**
   * @param {TransactionContextStatement} statement
   * @returns {Promise<import("pg").QueryResult<QueryResultRow>>}
   */
  const query = async (statement) => {
    calls.push(statement);
    const rows = rowsByCall[calls.length - 1] ?? [];
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  };
  const typed = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typed.calls = calls;
  return typed;
}

test("account status reports free-tier non-file storage and active limit blocks", async () => {
  const query = fakeQuery([
    [
      {
        account_id: identity.accountId,
        label: "Nick's Agent Outbox",
        tier: "hosted_free",
        billing_status: "not_applicable",
        billing_grace_ends_at: null
      }
    ],
    [{ non_file_stored_bytes: "384", overall_stored_bytes: "8192" }],
    [
      {
        operation_kind: "input_submission",
        limit_name: "queued_input_items",
        limit_reason_code: "queued_input_item_limit_exceeded",
        limit_reason: "Queued input item limit reached.",
        limit_resets_at: null,
        used_units: "100",
        limit_units: "100"
      }
    ]
  ]);

  const result = await accountStatusInTransaction(query, identity);

  assert.deepEqual(result, {
    ok: true,
    data: {
      account_id: identity.accountId,
      label: "Nick's Agent Outbox",
      tier: "hosted_free",
      effective_tier: "free",
      billing_status: "not_applicable",
      grace_ends_at: null,
      file_upload_enabled: false,
      storage: {
        stored_bytes: 384,
        limit_name: "stored_non_file_queue_payload_bytes",
        limit_bytes: 32_000_000
      },
      active_limit_blocks: [
        {
          operation_kind: "input_submission",
          limit_name: "queued_input_items",
          limit_reason_code: "queued_input_item_limit_exceeded",
          limit_reason: "Queued input item limit reached.",
          limit_resets_at: null,
          used_units: 100,
          limit_units: 100
        }
      ]
    }
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret|stripe_customer|response_payload|file_bytes/i
  );
});

test("account status reports paid-tier overall storage cap", async () => {
  const query = fakeQuery([
    [
      {
        account_id: identity.accountId,
        label: null,
        tier: "hosted_paid",
        billing_status: "active",
        billing_grace_ends_at: new Date("2026-07-07T00:00:00.000Z")
      }
    ],
    [{ non_file_stored_bytes: "384", overall_stored_bytes: "8192" }],
    []
  ]);

  const result = await accountStatusInTransaction(query, identity);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected account status success");
  }
  assert.deepEqual(result.data.storage, {
    stored_bytes: 8192,
    limit_name: "overall_stored_account_data_bytes",
    limit_bytes: 1_000_000_000
  });
  assert.equal(result.data.effective_tier, "paid");
  assert.equal(result.data.file_upload_enabled, true);
  assert.equal(result.data.grace_ends_at, "2026-07-07T00:00:00.000Z");
});

test("account status storage reads use the canonical stock usage function", () => {
  const statement = storageStatusStatement(identity);

  assert.match(statement.sql, /agent_outbox_account_stock_usage\(\$1\)/);
  assert.deepEqual(statement.values, [identity.accountId]);
});

test("caller status is scoped to the authenticated caller and key metadata only", async () => {
  const query = fakeQuery([
    [
      {
        caller_id: identity.callerId,
        caller_slug: "steward-email",
        display_name: "Steward Email",
        status: "active",
        key_id: "key_123",
        key_prefix: "aob_live_keyprefix",
        key_last_four: "abcd",
        created_at: "2026-06-30T20:00:00.000Z",
        last_used_at: "2026-06-30T20:05:00.000Z"
      }
    ],
    [
      {
        account_id: identity.accountId,
        label: "Nick's Agent Outbox",
        tier: "hosted_free",
        billing_status: "not_applicable",
        billing_grace_ends_at: null
      }
    ],
    [{ non_file_stored_bytes: "0", overall_stored_bytes: "0" }],
    []
  ]);

  const result = await callerStatusInTransaction(query, identity, "key_123");

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected caller status success");
  }
  assert.equal(result.data.caller.caller_id, identity.callerId);
  assert.deepEqual(result.data.caller.key, {
    key_id: "key_123",
    prefix: "aob_live_keyprefix",
    last_chars: "abcd",
    created_at: "2026-06-30T20:00:00.000Z",
    last_used_at: "2026-06-30T20:05:00.000Z"
  });
  assert.deepEqual(query.calls[0].values, [
    identity.accountId,
    identity.callerId,
    "key_123"
  ]);
  assert.doesNotMatch(
    query.calls[0].sql,
    /secret_hmac_sha256|file_bytes|response_payload/i
  );
  assert.doesNotMatch(JSON.stringify(result), /secret_hmac_sha256|file_bytes/i);
});

test("status fails loudly when the authenticated account row is missing", async () => {
  const query = fakeQuery([[]]);

  const result = await accountStatusInTransaction(query, identity);

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message: "Account status is temporarily unavailable."
    }
  });
});
