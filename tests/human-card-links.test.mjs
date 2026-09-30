import assert from "node:assert/strict";
import test from "node:test";

import {
  humanReviewCardInTransaction,
  humanReviewPageInTransaction,
  humanReviewDetailInTransaction
} from "../src/server/human-review.ts";
import {
  humanReviewCardHref,
  humanReviewReturnHref
} from "../src/shared/human-review-view.ts";
import {
  DATABASE_POLICY_VERIFICATION_SKIP,
  assertMigrationOwnerCanSetAppRole,
  connectedDatabaseClient,
  phase3DatabaseVerificationUrl,
  preserveBodyErrorDuringTeardown,
  resetRoleAndRollback
} from "./helpers/database.mjs";

test("card links encode arbitrary caller IDs and survive the sign-in return URL", () => {
  const id = "email:thread /?#&+% café 東京";
  const href = humanReviewCardHref("caller-one", id);
  const url = new URL(href, "https://app.agent-outbox.dev");
  assert.equal(url.searchParams.get("caller_id"), "caller-one");
  assert.equal(url.searchParams.get("caller_item_id"), id);
  assert.equal(humanReviewReturnHref(href), href);
  for (const invalid of [
    undefined,
    "//evil.example/human",
    "https://evil.example/human",
    "/\\evil.example/human",
    "/human/other",
    "/caller/connect/approve"
  ]) {
    assert.equal(humanReviewReturnHref(invalid), undefined);
  }
});

const databaseUrl = phase3DatabaseVerificationUrl();
test(
  "card links locate canonical queue pages and isolate callers and accounts",
  { skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP },
  async () => {
    assert.ok(databaseUrl);
    const client = await connectedDatabaseClient(databaseUrl);
    const accountId = crypto.randomUUID();
    const otherAccountId = crypto.randomUUID();
    const callerId = crypto.randomUUID();
    const secondCallerId = crypto.randomUUID();
    const foreignCallerId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const copiedId = "email:thread /?#&+% café 東京";
    /** @type {import("../src/server/authorization.ts").AuthorizedHumanAccountContext} */
    const context = { surface: "human", accountId, userId, role: "owner" };
    /** @type {import("../src/server/database.ts").ProductTransactionQuery} */
    const query = (statement) => client.query(statement.sql, statement.values);
    /** @type {unknown} */
    let bodyError;
    try {
      await assertMigrationOwnerCanSetAppRole(client);
      await client.query("begin");
      for (const id of [accountId, otherAccountId]) {
        await client.query(
          "insert into public.agent_outbox_accounts(account_id) values ($1)",
          [id]
        );
      }
      await client.query(
        "insert into public.agent_outbox_users(user_id, clerk_user_id) values ($1, $2)",
        [userId, `clerk-${userId}`]
      );
      await client.query(
        "insert into public.agent_outbox_account_members(account_id, user_id, role) values ($1, $2, 'owner')",
        [accountId, userId]
      );
      for (const [caller, account] of [
        [callerId, accountId],
        [secondCallerId, accountId],
        [foreignCallerId, otherAccountId]
      ]) {
        await client.query(
          "insert into public.agent_outbox_callers(caller_id, account_id, display_name) values ($1, $2, 'Link test caller')",
          [caller, account]
        );
      }
      for (let index = 0; index < 104; index++) {
        const isTarget = index === 100;
        const secondCaller = index === 102;
        const foreign = index === 103;
        await client.query(
          `insert into public.agent_outbox_input_items(
        input_item_id, account_id, caller_id, caller_item_id, caller_item_id_hash,
        priority, row_type_display, row_type_icon, title_html, subtitle_html, summary_html,
        updated_at
      ) values ($1, $2, $3, $4, 'fixture-hash', $5, 'Link test', 'link', 'Review', 'Context', 'Summary', $6)`,
          [
            isTarget ? targetId : crypto.randomUUID(),
            foreign ? otherAccountId : accountId,
            foreign
              ? foreignCallerId
              : secondCaller
                ? secondCallerId
                : callerId,
            isTarget || secondCaller || foreign ? copiedId : `card-${index}`,
            isTarget ? "low" : "normal",
            "2026-09-30T00:00:00.000Z"
          ]
        );
      }
      await client.query("set local role agent_outbox_app");
      for (const [key, value] of Object.entries({
        auth_surface: "human",
        account_id: accountId,
        user_id: userId,
        request_id: "req-card-links"
      })) {
        await client.query("select set_config($1, $2, true)", [
          `agent_outbox.${key}`,
          value
        ]);
      }
      const target = await humanReviewCardInTransaction(
        query,
        context,
        callerId,
        copiedId
      );
      assert.deepEqual(target, {
        inputItemId: targetId,
        status: "pending",
        page: 2
      });
      assert.ok(target);
      const page = await humanReviewPageInTransaction(query, context, {
        status: target.status,
        sorts: [{ key: "priority", direction: "asc" }],
        offset: (target.page - 1) * 100
      });
      assert.ok(page.rows.some((row) => row.inputItemId === targetId));
      const detail = await humanReviewDetailInTransaction(
        query,
        context,
        targetId
      );
      assert.equal(detail?.callerItemId, copiedId);
      const second = await humanReviewCardInTransaction(
        query,
        context,
        secondCallerId,
        copiedId
      );
      assert.ok(second);
      assert.notEqual(second.inputItemId, targetId);
      assert.equal(
        await humanReviewCardInTransaction(
          query,
          context,
          foreignCallerId,
          copiedId
        ),
        null
      );
      assert.equal(
        await humanReviewCardInTransaction(query, context, callerId, "missing"),
        null
      );
      assert.equal(
        await humanReviewCardInTransaction(
          query,
          context,
          "not-a-uuid",
          copiedId
        ),
        null
      );
      for (const [caller, id] of [
        [callerId, "invalid\0id"],
        ["invalid\0caller", copiedId]
      ]) {
        assert.equal(
          await humanReviewCardInTransaction(query, context, caller, id),
          null
        );
      }
      await client.query("reset role");
      await client.query(
        "update public.agent_outbox_input_items set status = 'answered' where input_item_id = $1",
        [targetId]
      );
      await client.query("set local role agent_outbox_app");
      assert.deepEqual(
        await humanReviewCardInTransaction(query, context, callerId, copiedId),
        { inputItemId: targetId, status: "answered", page: 1 }
      );
      await client.query("reset role");
      await client.query(
        "delete from public.agent_outbox_input_items where input_item_id = $1",
        [targetId]
      );
      await client.query("set local role agent_outbox_app");
      assert.equal(
        await humanReviewCardInTransaction(query, context, callerId, copiedId),
        null
      );
    } catch (error) {
      bodyError = error;
    }
    await preserveBodyErrorDuringTeardown(
      bodyError,
      async () => {
        try {
          await resetRoleAndRollback(client);
        } finally {
          await client.end();
        }
      },
      "Card link verification and teardown failed."
    );
  }
);
