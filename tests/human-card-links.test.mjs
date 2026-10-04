import assert from "node:assert/strict";
import test from "node:test";

import {
  productTransactionBeginSql,
  runProductTransaction
} from "../src/server/database.ts";
import {
  humanReviewCardInTransaction,
  humanReviewPageInTransaction,
  humanReviewDetailInTransaction
} from "../src/server/human-review.ts";
import { loadHumanReviewPage } from "../src/server/human-review-page.ts";
import {
  humanReviewCardHref,
  humanReviewViewFromRecord
} from "../src/shared/human-review-view.ts";
import { signInReturnHref } from "../src/shared/sign-in-return.ts";
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
  assert.equal(signInReturnHref(href), href);
  for (const invalid of [
    undefined,
    "//evil.example/human",
    "https://evil.example/human",
    "/\\evil.example/human",
    "/human/other",
    "/caller/connect/storyboard",
    "/caller/connect/approve/other"
  ]) {
    assert.equal(signInReturnHref(invalid), undefined);
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
    const foreignItemId = crypto.randomUUID();
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
            isTarget ? targetId : foreign ? foreignItemId : crypto.randomUUID(),
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
      for (const id of [
        "invalid\0id",
        "not-a-uuid",
        targetId.toUpperCase(),
        foreignItemId
      ]) {
        assert.equal(
          await humanReviewDetailInTransaction(query, context, id),
          null,
          id
        );
      }
      for (const filter of [{ search: "Review\0" }, { types: ["Link\0"] }]) {
        assert.deepEqual(
          await humanReviewPageInTransaction(query, context, filter),
          { totalCount: 0, rows: [], hasNext: false }
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

test("product transactions can request a repeatable-read snapshot", () => {
  assert.equal(productTransactionBeginSql(), "begin");
  assert.equal(productTransactionBeginSql("read committed"), "begin");
  assert.equal(
    productTransactionBeginSql("repeatable read"),
    "begin isolation level repeatable read"
  );
  assert.throws(() =>
    productTransactionBeginSql(/** @type {"read committed"} */ ("serializable"))
  );
});

test("linked card reads run after session bootstrap in one repeatable-read transaction", async () => {
  const accountId = "00000000-0000-4000-8000-000000000911";
  const userId = "00000000-0000-4000-8000-000000000912";
  const inputItemId = "00000000-0000-4000-8000-000000000913";
  const previousDatabaseUrl = process.env.DATABASE_APP_ROLE_URL;
  process.env.DATABASE_APP_ROLE_URL = "postgresql://human-review-page-test";
  /** @type {{ options: { isolationLevel?: string } | null, statements: { sql: string, values?: unknown[] }[] }[]} */
  const calls = [];
  /** @type {typeof runProductTransaction} */
  const runTransaction = async (
    _connectionString,
    _context,
    callback,
    options
  ) => {
    /** @type {{ sql: string, values?: unknown[] }[]} */
    const statements = [];
    calls.push({ options: options ?? null, statements });
    const query = async (
      /** @type {{ sql: string, values?: unknown[] }} */ statement
    ) => {
      statements.push(statement);
      if (/agent_outbox_bootstrap_clerk_human/.test(statement.sql)) {
        return queryRows([
          {
            user_id: userId,
            account_id: accountId,
            role: "owner",
            provisioned_account: false
          }
        ]);
      }
      if (/agent_outbox_account_members/.test(statement.sql)) {
        return queryRows([
          { account_id: accountId, user_id: userId, role: "owner" }
        ]);
      }
      if (/agent_outbox_accounts/.test(statement.sql)) {
        return queryRows([
          {
            account_id: accountId,
            label: "Link test",
            tier: "hosted_free",
            billing_status: "not_applicable",
            billing_grace_ends_at: null
          }
        ]);
      }
      if (/partition by i\.status/.test(statement.sql)) {
        return queryRows([
          { input_item_id: inputItemId, status: "pending", position: "150" }
        ]);
      }
      if (/count\(\*\)/.test(statement.sql)) {
        return queryRows([{ total_count: "150" }]);
      }
      return queryRows([]);
    };
    return callback(
      /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
        /** @type {unknown} */ (query)
      )
    );
  };

  try {
    const requestedView = humanReviewViewFromRecord({
      status: "answered",
      page: "9"
    });
    const linked = await loadHumanReviewPage(
      {
        clerkUserId: "user_card_link",
        requestId: "req-linked-card-snapshot"
      },
      {
        selectedItem: null,
        view: requestedView,
        cardLink: { callerId: "caller-1", callerItemId: "card-1" }
      },
      { runTransaction }
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options, null);
    assert.equal(calls[1].options?.isolationLevel, "repeatable read");
    assert.equal(
      calls[0].statements.some((statement) =>
        /partition by i\.status/.test(statement.sql)
      ),
      false
    );
    const lookupAt = calls[1].statements.findIndex((statement) =>
      /partition by i\.status/.test(statement.sql)
    );
    const pageAt = calls[1].statements.findIndex((statement) =>
      /limit \$/.test(statement.sql)
    );
    const detailAt = calls[1].statements.findIndex((statement) =>
      /details_html/.test(statement.sql)
    );
    assert.ok(lookupAt >= 0 && pageAt > lookupAt && detailAt > pageAt);
    assert.ok(calls[1].statements[pageAt]?.values?.includes("pending"));
    assert.ok(calls[1].statements[detailAt]?.values?.includes(inputItemId));
    assert.equal(linked.ok, true);
    if (linked.ok) {
      assert.equal(linked.data.view.status, "pending");
      assert.equal(linked.data.view.page, 2);
      assert.equal(linked.data.detail, null);
    }

    calls.length = 0;
    const ordinary = await loadHumanReviewPage(
      {
        clerkUserId: "user_card_link",
        requestId: "req-ordinary-review-page"
      },
      { selectedItem: null, view: requestedView, cardLink: null },
      { runTransaction }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options, null);
    assert.equal(
      calls[0].statements.some((statement) =>
        /partition by i\.status/.test(statement.sql)
      ),
      false
    );
    assert.equal(
      calls[0].statements.some((statement) =>
        /count\(\*\)/.test(statement.sql)
      ),
      true
    );
    assert.equal(ordinary.ok, true);
    if (ordinary.ok) {
      assert.equal(ordinary.data.view.status, "answered");
      assert.equal(ordinary.data.view.page, 9);
    }
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_APP_ROLE_URL;
    } else {
      process.env.DATABASE_APP_ROLE_URL = previousDatabaseUrl;
    }
  }
});

test(
  "repeatable read keeps a linked card on the queue page after a concurrent answer",
  { skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP },
  async () => {
    assert.ok(databaseUrl);
    const owner = await connectedDatabaseClient(databaseUrl);
    const reader = await connectedDatabaseClient(databaseUrl);
    const accountId = crypto.randomUUID();
    const callerId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const inputItemId = crypto.randomUUID();
    const callerItemId = "linked-card-snapshot";
    /** @type {import("../src/server/authorization.ts").AuthorizedHumanAccountContext} */
    const context = { surface: "human", accountId, userId, role: "owner" };
    /** @type {import("../src/server/database.ts").ProductTransactionQuery} */
    const read = (statement) => reader.query(statement.sql, statement.values);
    /** @type {unknown} */
    let bodyError;
    try {
      await assertMigrationOwnerCanSetAppRole(owner);
      await owner.query("begin");
      await owner.query(
        "insert into public.agent_outbox_accounts(account_id) values ($1)",
        [accountId]
      );
      await owner.query(
        "insert into public.agent_outbox_users(user_id, clerk_user_id) values ($1, $2)",
        [userId, `clerk-${userId}`]
      );
      await owner.query(
        "insert into public.agent_outbox_account_members(account_id, user_id, role) values ($1, $2, 'owner')",
        [accountId, userId]
      );
      await owner.query(
        "insert into public.agent_outbox_callers(caller_id, account_id, display_name) values ($1, $2, 'Link test caller')",
        [callerId, accountId]
      );
      await owner.query(
        `insert into public.agent_outbox_input_items(
          input_item_id, account_id, caller_id, caller_item_id, caller_item_id_hash,
          priority, row_type_display, row_type_icon, title_html, subtitle_html, summary_html,
          updated_at
        ) values ($1, $2, $3, $4, 'snapshot-hash', 'normal', 'Link test', 'link', 'Review', 'Context', 'Summary', $5)`,
        [
          inputItemId,
          accountId,
          callerId,
          callerItemId,
          "2026-09-30T00:00:00.000Z"
        ]
      );
      await owner.query("commit");

      await reader.query("begin isolation level repeatable read");
      await applyHumanReviewContext(reader, accountId, userId);
      const linked = await humanReviewCardInTransaction(
        read,
        context,
        callerId,
        callerItemId
      );
      assert.deepEqual(linked, {
        inputItemId,
        status: "pending",
        page: 1
      });
      await owner.query(
        "update public.agent_outbox_input_items set status = 'answered' where input_item_id = $1",
        [inputItemId]
      );
      const stablePage = await humanReviewPageInTransaction(read, context, {
        status: "pending",
        offset: 0
      });
      const stableDetail = await humanReviewDetailInTransaction(
        read,
        context,
        inputItemId
      );
      assert.equal(
        stablePage.rows.some((row) => row.inputItemId === inputItemId),
        true
      );
      assert.equal(stableDetail?.status, "pending");
      await reader.query("commit");

      await owner.query(
        "update public.agent_outbox_input_items set status = 'pending' where input_item_id = $1",
        [inputItemId]
      );
      await reader.query("begin");
      await applyHumanReviewContext(reader, accountId, userId);
      const drifted = await humanReviewCardInTransaction(
        read,
        context,
        callerId,
        callerItemId
      );
      assert.equal(drifted?.status, "pending");
      await owner.query(
        "update public.agent_outbox_input_items set status = 'answered' where input_item_id = $1",
        [inputItemId]
      );
      const driftedPage = await humanReviewPageInTransaction(read, context, {
        status: "pending",
        offset: 0
      });
      const driftedDetail = await humanReviewDetailInTransaction(
        read,
        context,
        inputItemId
      );
      assert.equal(
        driftedPage.rows.some((row) => row.inputItemId === inputItemId),
        false
      );
      assert.equal(driftedDetail?.status, "answered");
    } catch (error) {
      bodyError = error;
    }
    await preserveBodyErrorDuringTeardown(
      bodyError,
      async () => {
        const teardownErrors = [];
        try {
          await resetRoleAndRollback(reader);
        } catch (error) {
          teardownErrors.push(error);
        }
        try {
          await owner.query("rollback");
        } catch (error) {
          teardownErrors.push(error);
        }
        try {
          await owner.query(
            "delete from public.agent_outbox_accounts where account_id = $1",
            [accountId]
          );
          await owner.query(
            "delete from public.agent_outbox_users where user_id = $1",
            [userId]
          );
        } catch (error) {
          teardownErrors.push(error);
        }
        await Promise.all([
          owner.end().catch((error) => teardownErrors.push(error)),
          reader.end().catch((error) => teardownErrors.push(error))
        ]);
        if (teardownErrors.length > 0) {
          throw new AggregateError(
            teardownErrors,
            "Linked card snapshot verification and teardown failed."
          );
        }
      },
      "Linked card snapshot verification and teardown failed."
    );
  }
);

test(
  "runProductTransaction applies repeatable read only when requested",
  { skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP },
  async () => {
    assert.ok(databaseUrl);
    const repeatable = await runProductTransaction(
      databaseUrl,
      { requestId: "req-repeatable-read", authSurface: "human" },
      async (query) => {
        const result = await query({
          sql: "select current_setting('transaction_isolation') as isolation"
        });
        return result.rows[0]?.isolation;
      },
      { isolationLevel: "repeatable read" }
    );
    assert.equal(repeatable, "repeatable read");
    const committed = await runProductTransaction(
      databaseUrl,
      { requestId: "req-read-committed", authSurface: "human" },
      async (query) => {
        const result = await query({
          sql: "select current_setting('transaction_isolation') as isolation"
        });
        return result.rows[0]?.isolation;
      }
    );
    assert.equal(committed, "read committed");
  }
);

/**
 * @param {import("pg").QueryResultRow[]} rows
 */
function queryRows(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

/**
 * @param {import("pg").Client} client
 * @param {string} accountId
 * @param {string} userId
 */
async function applyHumanReviewContext(client, accountId, userId) {
  await client.query("set local role agent_outbox_app");
  for (const [key, value] of Object.entries({
    auth_surface: "human",
    account_id: accountId,
    user_id: userId,
    request_id: "req-linked-card-snapshot"
  })) {
    await client.query("select set_config($1, $2, true)", [
      `agent_outbox.${key}`,
      value
    ]);
  }
}
