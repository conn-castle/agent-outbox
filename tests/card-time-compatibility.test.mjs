import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalInputIntegrityError } from "../src/server/canonical-input.ts";
import {
  createHumanAnswerInTransaction,
  undoHumanAnswerBeforeReadInTransaction
} from "../src/server/human-answer.ts";
import { handleInputQueueRequestInTransaction } from "../src/server/input-queue.ts";
import { readInputInTransaction } from "../src/server/input-read.ts";
import { sha256Hex, stableStringify } from "../src/server/input-schema.ts";
import { readOutputResultInTransaction } from "../src/server/output-queue.ts";
import {
  DATABASE_POLICY_VERIFICATION_SKIP,
  assertMigrationOwnerCanSetAppRole,
  connectedDatabaseClient,
  phase3DatabaseVerificationUrl,
  preserveBodyErrorDuringTeardown,
  resetRoleAndRollback
} from "./helpers/database.mjs";

const databaseUrl = phase3DatabaseVerificationUrl();

test(
  "compatibility release reads and answers future card times, detects tampering, and clears them on replace",
  { skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP },
  async () => {
    assert.ok(databaseUrl);
    const client = await connectedDatabaseClient(databaseUrl);
    const identity = {
      accountId: crypto.randomUUID(),
      callerId: crypto.randomUUID()
    };
    const userId = crypto.randomUUID();
    const context = {
      requestId: "req-card-time-compatibility",
      correlationId: "corr-card-time-compatibility"
    };
    /** @type {import("../src/server/database.ts").ProductTransactionQuery} */
    const query = (statement) => client.query(statement.sql, statement.values);
    /** @param {string} surface */
    async function setSurface(surface) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        surface
      ]);
    }
    /** @type {unknown} */
    let bodyError;
    try {
      await assertMigrationOwnerCanSetAppRole(client);
      await client.query("begin");
      await client.query(
        "insert into public.agent_outbox_accounts(account_id, label) values ($1, 'Card time compatibility')",
        [identity.accountId]
      );
      await client.query(
        "insert into public.agent_outbox_users(user_id, clerk_user_id) values ($1, $2)",
        [userId, `clerk-${userId}`]
      );
      await client.query(
        "insert into public.agent_outbox_account_members(account_id, user_id, role) values ($1, $2, 'owner')",
        [identity.accountId, userId]
      );
      await client.query(
        "insert into public.agent_outbox_callers(caller_id, account_id, display_name) values ($1, $2, 'Card time caller')",
        [identity.callerId, identity.accountId]
      );
      await client.query("set local role agent_outbox_app");
      for (const [key, value] of Object.entries({
        account_id: identity.accountId,
        caller_id: identity.callerId,
        user_id: userId,
        request_id: context.requestId
      })) {
        await client.query("select set_config($1, $2, true)", [
          `agent_outbox.${key}`,
          value
        ]);
      }
      // Explicitly seed future data under the migration owner; normal submissions
      // in this release cannot create non-null values. The simple popup has no
      // internal option-order fields, so its public form is the fingerprint form.
      for (const timestamp of [
        "0001-01-01T00:00:00.000Z",
        "2026-09-29T12:34:56.123Z",
        "9999-12-31T23:59:59.999Z"
      ]) {
        const input = {
          caller_item_id: `card-time:${timestamp}`,
          row_type: { display: "Email", icon: "mail" },
          title: "Label email",
          subtitle: "Sender",
          summary: "Choose a label",
          link_buttons: [],
          actions: [
            {
              display: "Archive",
              icon: "archive",
              value: "archive",
              overflow: false,
              popup: { kind: "none" }
            }
          ]
        };
        await setSurface("caller");
        const rejected = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "send",
          { ...input, card_time: timestamp }
        );
        assert.equal(rejected.ok, false);
        if (rejected.ok)
          assert.fail("card time must not activate in release A");
        assert.equal(rejected.error.status, 422);

        const sent = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "send",
          input
        );
        assert.equal(sent.ok, true, JSON.stringify(sent));
        const initial = await readInputInTransaction(
          query,
          identity,
          input.caller_item_id
        );
        assert.equal(initial.ok, true);
        if (!initial.ok || !("raw_input" in initial.data)) {
          assert.fail("initial input must be readable");
        }
        assert.equal(initial.data.raw_input.card_time, null);
        const storedInput = await client.query(
          "select input_item_id from public.agent_outbox_input_items where caller_id = $1 and caller_item_id = $2",
          [identity.callerId, input.caller_item_id]
        );
        assert.equal(storedInput.rowCount, 1);
        const inputId = storedInput.rows[0].input_item_id;
        const futureInput = { ...initial.data.raw_input, card_time: timestamp };
        const futureFingerprint = sha256Hex(stableStringify(futureInput));
        await client.query("reset role");
        await client.query(
          "update public.agent_outbox_input_items set card_time = $2, normalized_content_fingerprint = $3 where input_item_id = $1",
          [inputId, timestamp, futureFingerprint]
        );
        await client.query("set local role agent_outbox_app");
        const read = await readInputInTransaction(
          query,
          identity,
          input.caller_item_id
        );
        assert.equal(read.ok, true);
        if (!read.ok || !("raw_input" in read.data)) {
          assert.fail("seeded future input must be readable");
        }
        assert.equal(read.data.raw_input.card_time, timestamp);

        await setSurface("human");
        const answer = await createHumanAnswerInTransaction(query, {
          ...identity,
          ...context,
          humanUserId: userId,
          inputItemId: inputId,
          expectedRevision: 1,
          actionValue: "archive",
          response: { kind: "none" }
        });
        assert.equal(answer.ok, true, JSON.stringify(answer));
        if (!answer.ok)
          assert.fail("future card time must not block answering");
        // Undo before the caller reads also preserves the timestamp.
        const undone = await undoHumanAnswerBeforeReadInTransaction(query, {
          ...identity,
          ...context,
          humanUserId: userId,
          outputResultId: answer.outputResultId
        });
        assert.equal(undone.ok, true);
        await setSurface("caller");
        const restored = await readInputInTransaction(
          query,
          identity,
          input.caller_item_id
        );
        assert.equal(restored.ok, true);
        if (!restored.ok || !("raw_input" in restored.data))
          assert.fail("undo must preserve the input");
        assert.equal(restored.data.raw_input.card_time, timestamp);
        await client.query("reset role");
        await client.query(
          "update public.agent_outbox_input_items set card_time = '2025-01-01T00:00:00Z' where input_item_id = $1",
          [inputId]
        );
        await client.query("set local role agent_outbox_app");
        await assert.rejects(
          () => readInputInTransaction(query, identity, input.caller_item_id),
          CanonicalInputIntegrityError
        );
        await client.query("reset role");
        await client.query(
          "update public.agent_outbox_input_items set card_time = $2 where input_item_id = $1",
          [inputId, timestamp]
        );
        await client.query("set local role agent_outbox_app");
        const replaced = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "replace",
          input
        );
        assert.equal(replaced.ok, true, JSON.stringify(replaced));
        if (!replaced.ok || !("changed" in replaced.data)) {
          assert.fail("replace must clear future card time");
        }
        assert.equal(replaced.data.changed, true);
        const cleared = await readInputInTransaction(
          query,
          identity,
          input.caller_item_id
        );
        assert.equal(cleared.ok, true);
        if (!cleared.ok || !("raw_input" in cleared.data)) {
          assert.fail("cleared input must verify");
        }
        assert.equal(cleared.data.raw_input.card_time, null);
        const unchanged = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "replace",
          { ...input, card_time: null }
        );
        assert.equal(unchanged.ok, true);
        if (!unchanged.ok || !("changed" in unchanged.data)) {
          assert.fail("identical replace must succeed");
        }
        assert.equal(unchanged.data.changed, false);
        await client.query("reset role");
        await client.query(
          "update public.agent_outbox_input_items set card_time = $2, normalized_content_fingerprint = $3 where input_item_id = $1",
          [inputId, timestamp, futureFingerprint]
        );
        await client.query("set local role agent_outbox_app");
        await setSurface("human");
        const answeredAgain = await createHumanAnswerInTransaction(query, {
          ...identity,
          ...context,
          humanUserId: userId,
          inputItemId: inputId,
          expectedRevision: cleared.data.revision,
          actionValue: "archive",
          response: { kind: "none" }
        });
        assert.equal(answeredAgain.ok, true);
        if (!answeredAgain.ok)
          assert.fail("re-answer must work after undo and replace");
        await setSurface("caller");
        const output = await readOutputResultInTransaction(
          query,
          identity,
          answeredAgain.outputResultId
        );
        assert.equal(output.ok, true);
        if (!output.ok || !("raw_input" in output.data))
          assert.fail("output must return canonical input");
        assert.equal(output.data.raw_input.card_time, timestamp);
        await client.query("reset role");
        await client.query(
          "update public.agent_outbox_input_items set card_time = '2025-01-01T00:00:00Z' where input_item_id = $1",
          [inputId]
        );
        await client.query("set local role agent_outbox_app");
        await assert.rejects(
          () =>
            readOutputResultInTransaction(
              query,
              identity,
              answeredAgain.outputResultId
            ),
          CanonicalInputIntegrityError
        );
      }
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          try {
            await resetRoleAndRollback(client);
          } finally {
            await client.end();
          }
        },
        "Card time verification and teardown both failed."
      );
    }
  }
);
