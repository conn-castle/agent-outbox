import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalInputIntegrityError } from "../src/server/canonical-input.ts";
import {
  createHumanAnswerInTransaction,
  undoHumanAnswerBeforeReadInTransaction
} from "../src/server/human-answer.ts";
import { handleInputQueueRequestInTransaction } from "../src/server/input-queue.ts";
import { readInputInTransaction } from "../src/server/input-read.ts";
import { humanReviewPageInTransaction } from "../src/server/human-review.ts";
import { compareHumanReviewRows } from "../src/shared/human-review-sort.ts";
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
  "card times survive send/read/answer/undo, detect tampering, clear on replace, and sort before pagination",
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
        const sent = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "send",
          { ...input, card_time: timestamp }
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
        assert.equal(initial.data.raw_input.card_time, timestamp);
        const storedInput = await client.query(
          "select input_item_id from public.agent_outbox_input_items where caller_id = $1 and caller_item_id = $2",
          [identity.callerId, input.caller_item_id]
        );
        assert.equal(storedInput.rowCount, 1);
        const inputId = storedInput.rows[0].input_item_id;
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

        const duplicate = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "send",
          { ...input, card_time: timestamp }
        );
        assert.equal(duplicate.ok, true);
        if (!duplicate.ok || !("duplicate" in duplicate.data))
          assert.fail("identical time must remain unchanged");
        assert.equal(duplicate.data.duplicate, true);
        const conflict = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "send",
          input
        );
        assert.equal(conflict.ok, false);
        if (conflict.ok) assert.fail("changed send must conflict");
        assert.equal(conflict.error.code, "pending_content_conflict");

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
        const restoredTime = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "replace",
          { ...input, card_time: timestamp }
        );
        assert.equal(restoredTime.ok, true);
        if (!restoredTime.ok || !("changed" in restoredTime.data))
          assert.fail("replace must restore time");
        assert.equal(restoredTime.data.changed, true);
        await setSurface("human");
        const answeredAgain = await createHumanAnswerInTransaction(query, {
          ...identity,
          ...context,
          humanUserId: userId,
          inputItemId: inputId,
          expectedRevision: restoredTime.data.revision,
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

      // Deliberately cross a page boundary with equal and absent event times.
      // Literal expected orders are independent of both SQL and client sorting.
      const values = [
        ["sort-a", "2026-09-29T12:00:00Z"],
        ["sort-b", null],
        ["sort-c", "2026-09-28T12:00:00Z"],
        ["sort-d", "2026-09-29T12:00:00.000Z"],
        ["sort-e", null],
        ["sort-f", "2026-09-30T12:00:00Z"],
        ["sort-g", "2026-09-27T12:00:00Z"]
      ];
      await setSurface("caller");
      for (const [name, cardTime] of values) {
        const sent = await handleInputQueueRequestInTransaction(
          query,
          context,
          identity,
          "send",
          {
            caller_item_id: name,
            card_time: cardTime,
            row_type: { display: "Email", icon: "mail" },
            title: name,
            subtitle: "Sort test",
            summary: "Choose",
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
          }
        );
        assert.equal(sent.ok, true, JSON.stringify(sent));
      }
      await setSurface("human");
      /** @type {import("../src/server/authorization.ts").AuthorizedHumanAccountContext} */
      const human = {
        surface: "human",
        accountId: identity.accountId,
        userId,
        role: "owner"
      };
      /** @type {Array<[import("../src/shared/human-review-view.ts").HumanReviewSortDirection, string[]]>} */
      const orders = [
        [
          "asc",
          ["sort-g", "sort-c", "sort-a", "sort-d", "sort-f", "sort-b", "sort-e"]
        ],
        [
          "desc",
          ["sort-f", "sort-a", "sort-d", "sort-c", "sort-g", "sort-b", "sort-e"]
        ]
      ];
      for (const [direction, expected] of orders) {
        /** @type {import("../src/shared/human-review-view.ts").HumanReviewSortRule[]} */
        const sorts = [
          { key: "card_time", direction },
          { key: "title", direction: "asc" }
        ];
        const { rows } = await humanReviewPageInTransaction(query, human, {
          status: "pending",
          sorts
        });
        assert.deepEqual(
          rows.map((row) => row.callerItemId),
          expected
        );
        const offsetPage = await humanReviewPageInTransaction(query, human, {
          status: "pending",
          sorts,
          offset: 3
        });
        assert.deepEqual(
          offsetPage.rows.map((row) => row.callerItemId),
          expected.slice(3)
        );
        assert.equal(rows[rows.length - 1].cardTime, null);
        assert.deepEqual(
          [...rows]
            .reverse()
            .sort((left, right) =>
              compareHumanReviewRows(left, right, { sorts })
            )
            .map((row) => row.callerItemId),
          expected
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
