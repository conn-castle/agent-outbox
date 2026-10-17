import assert from "node:assert/strict";
import test from "node:test";
import { runProductTransaction } from "../src/server/database.ts";
import {
  handleInputQueueRequestInTransaction,
  insertInputItemStatement,
  updateInputItemStatement
} from "../src/server/input-queue.ts";
import { parseInputSubmission } from "../src/server/input-schema.ts";
import { readInputInTransaction } from "../src/server/input-read.ts";
import { humanReviewPageInTransaction } from "../src/server/human-review.ts";
import {
  createHumanAnswerInTransaction,
  undoHumanAnswerBeforeReadInTransaction
} from "../src/server/human-answer.ts";
import {
  deriveReviewSearchTextForAccount,
  reviewTextSourceDigestSql
} from "../src/server/review-search-text.ts";
import {
  DATABASE_POLICY_VERIFICATION_SKIP,
  phase3DatabaseVerificationUrl,
  connectedDatabaseClient,
  assertMigrationOwnerCanSetAppRole
} from "./helpers/database.mjs";

const databaseUrl = phase3DatabaseVerificationUrl();
const projection = [
  "title_text",
  "subtitle_text",
  "summary_text",
  "review_text_source_sha256"
];

// Verbatim SQL from v0.7.0, intentionally independent of current writers.
const legacyInsert = `
      insert into public.agent_outbox_input_items (
        account_id,
        caller_id,
        caller_item_id,
        caller_item_id_hash,
        status,
        priority,
        current_revision,
        row_type_display,
        row_type_icon,
        row_accent_color,
        title_html,
        subtitle_html,
        corner_html,
        summary_html,
        details_html,
        card_visual_kind,
        card_visual_payload,
        skip_disabled,
        normalized_content_fingerprint,
        non_file_payload_bytes,
        card_time
      )
      values (
        $1, $2, $3, $4, 'pending', $5, 1, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19
      )
      on conflict (caller_id, caller_item_id) do nothing
      returning input_item_id, current_revision
    `;
const legacyUpdate = `
      update public.agent_outbox_input_items
      set
        priority = $2,
        current_revision = current_revision + 1,
        row_type_display = $3,
        row_type_icon = $4,
        row_accent_color = $5,
        title_html = $6,
        subtitle_html = $7,
        corner_html = $8,
        summary_html = $9,
        details_html = $10,
        card_visual_kind = $11,
        card_visual_payload = $12::jsonb,
        skip_disabled = $13,
        normalized_content_fingerprint = $14,
        non_file_payload_bytes = $15,
        card_time = $16,
        updated_at = now()
      where input_item_id = $1
      returning current_revision
    `;

test(
  "decoded review search preserves canonical input and repairs legacy writes in committed bounded batches",
  { skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP },
  async () => {
    assert.ok(databaseUrl);
    const owner = await connectedDatabaseClient(databaseUrl);
    const locker = await connectedDatabaseClient(databaseUrl);
    const identity = {
      accountId: crypto.randomUUID(),
      callerId: crypto.randomUUID()
    };
    const other = {
      accountId: crypto.randomUUID(),
      callerId: crypto.randomUUID()
    };
    const userId = crypto.randomUUID();
    const context = {
      requestId: "req-decoded-search",
      correlationId: "corr-decoded-search"
    };
    const human = {
      surface: /** @type {const} */ ("human"),
      accountId: identity.accountId,
      userId,
      role: /** @type {const} */ ("owner")
    };
    /** @type {typeof runProductTransaction} */
    const appTransaction = (url, ctx, callback) =>
      runProductTransaction(url, ctx, async (query) => {
        await query({ sql: "set local role agent_outbox_app" });
        await query({ sql: "set local lock_timeout = '250ms'" });
        return callback(query);
      });
    /** @param {string} title @param {string} [name] */
    const input = (title, name = "entity") => ({
      caller_item_id: name,
      row_type: { display: "Email", icon: "mail" },
      title,
      subtitle: "GitHub &lt;noreply@github.com&gt;",
      summary: "caf&eacute; review",
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
    });
    /** @param {string} title @param {string} [name] */
    function normalized(title, name) {
      const parsed = parseInputSubmission(input(title, name), {
        limitProfile: "self-hosted"
      });
      if (!parsed.ok) assert.fail(JSON.stringify(parsed));
      return parsed.submission;
    }
    /** @param {string} title @param {string} [name] @param {"send" | "replace"} [operation] */
    const write = (title, name = "entity", operation = "send") =>
      appTransaction(
        databaseUrl,
        { ...context, authSurface: "caller", ...identity },
        async (query) => {
          const result = await handleInputQueueRequestInTransaction(
            query,
            context,
            identity,
            operation,
            input(title, name)
          );
          assert.equal(result.ok, true, JSON.stringify(result));
        }
      );
    /** @param {string} search @param {"pending" | "answered"} [status] */
    const page = (search, status = "pending") =>
      appTransaction(
        databaseUrl,
        { ...context, authSurface: "human", ...identity, userId },
        (query) =>
          humanReviewPageInTransaction(query, human, {
            status,
            search,
            sorts: [{ key: "title", direction: "asc" }]
          })
      );
    const derive = () =>
      deriveReviewSearchTextForAccount({
        connectionString: databaseUrl,
        ...context,
        accountId: identity.accountId,
        runTransaction: appTransaction
      });
    const stored = async () =>
      (
        await owner.query(
          "select * from public.agent_outbox_input_items where account_id = $1 order by input_item_id",
          [identity.accountId]
        )
      ).rows;
    /** @param {Record<string, unknown>[]} rows */
    const canonical = (rows) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => !projection.includes(key))
        )
      );
    try {
      await assertMigrationOwnerCanSetAppRole(owner);
      for (const target of [identity, other]) {
        await owner.query(
          "insert into public.agent_outbox_accounts(account_id, label, tier) values ($1, 'Decoded search verification', 'self_hosted')",
          [target.accountId]
        );
        await owner.query(
          "insert into public.agent_outbox_callers(caller_id, account_id, display_name) values ($1, $2, 'Search caller')",
          [target.callerId, target.accountId]
        );
      }
      await owner.query(
        "insert into public.agent_outbox_users(user_id, clerk_user_id) values ($1, $2)",
        [userId, `clerk-${userId}`]
      );
      await owner.query(
        "insert into public.agent_outbox_account_members(account_id, user_id, role) values ($1, $2, 'owner')",
        [identity.accountId, userId]
      );
      await write("AT&amp;T renewal");
      for (const term of ["AT&T", "<noreply@", "café"]) {
        const result = await page(term);
        assert.equal(result.rows.length, 1);
        assert.equal(result.totalCount, 1);
      }
      for (const term of ["amp", "lt;"])
        assert.equal((await page(term)).totalCount, 0);
      await appTransaction(
        databaseUrl,
        { ...context, authSurface: "caller", ...identity },
        async (query) => {
          const read = await readInputInTransaction(query, identity, "entity");
          if (!read.ok || !("raw_input" in read.data))
            assert.fail(JSON.stringify(read));
          for (const key of /** @type {const} */ ([
            "title",
            "subtitle",
            "summary"
          ]))
            assert.equal(
              read.data.raw_input[key],
              input("AT&amp;T renewal")[key]
            );
        }
      );
      const row = (await stored())[0];
      assert.match(row.review_text_source_sha256, /^[a-f0-9]{64}$/);
      const beforeAnswer = projection.map((key) => row[key]);
      await appTransaction(
        databaseUrl,
        { ...context, authSurface: "human", ...identity, userId },
        async (query) => {
          const answer = await createHumanAnswerInTransaction(query, {
            ...identity,
            ...context,
            humanUserId: userId,
            inputItemId: row.input_item_id,
            expectedRevision: 1,
            actionValue: "archive",
            response: { kind: "none" }
          });
          if (!answer.ok) assert.fail(JSON.stringify(answer));
          assert.equal(
            (
              await humanReviewPageInTransaction(query, human, {
                status: "answered",
                search: "AT&T"
              })
            ).totalCount,
            1
          );
          assert.equal(
            (
              await undoHumanAnswerBeforeReadInTransaction(query, {
                ...identity,
                ...context,
                humanUserId: userId,
                outputResultId: answer.outputResultId
              })
            ).ok,
            true
          );
        }
      );
      const afterUndo = (await stored())[0];
      assert.deepEqual(
        projection.map((key) => afterUndo[key]),
        beforeAnswer
      );
      assert.ok(afterUndo.current_revision > row.current_revision);
      assert.equal((await page("AT&T")).totalCount, 1);
      assert.equal((await page("AT&T", "answered")).totalCount, 0);
      await write("New &amp; improved", "entity", "replace");
      assert.equal((await page("New & improved")).totalCount, 1);
      assert.equal((await page("AT&T")).totalCount, 0);
      await write("&#90;ebra", "zebra");
      await write("Apple", "apple");
      assert.deepEqual(
        (await page("")).rows.map((item) => item.callerItemId),
        ["apple", "entity", "zebra"]
      );
      // A legacy replacement of an already-derived row cannot leave old search text.
      const replacement = updateInputItemStatement(
        row.input_item_id,
        normalized("Legacy &amp; title")
      );
      await appTransaction(
        databaseUrl,
        { ...context, authSurface: "caller", ...identity },
        (query) =>
          query({ sql: legacyUpdate, values: replacement.values?.slice(0, 16) })
      );
      assert.equal((await page("New & improved")).totalCount, 0);
      assert.equal((await page("Legacy &amp; title")).totalCount, 1);
      const legacyRow = (await stored()).find(
        (item) => item.input_item_id === row.input_item_id
      );
      assert.deepEqual(
        projection.map((key) => legacyRow[key]),
        [null, null, null, null]
      );
      const legacy = insertInputItemStatement(
        identity,
        normalized("Invalid &#0; &#xD800; &#x110000;", "legacy-insert")
      );
      await appTransaction(
        databaseUrl,
        { ...context, authSurface: "caller", ...identity },
        (query) =>
          query({ sql: legacyInsert, values: legacy.values?.slice(0, 19) })
      );
      const insertedLegacy = (await stored()).find(
        (item) => item.caller_item_id === "legacy-insert"
      );
      assert.deepEqual(
        projection.map((key) => insertedLegacy[key]),
        [null, null, null, null]
      );
      const before = canonical(await stored());
      assert.equal(await derive(), 2);
      assert.deepEqual(canonical(await stored()), before);
      assert.equal((await page("Legacy & title")).totalCount, 1);
      assert.equal((await page("Invalid � � �")).totalCount, 1);
      assert.equal(await derive(), 0);
      for (const assignment of [
        "review_text_source_sha256 = 'wrong'",
        `review_text_source_sha256 = ${reviewTextSourceDigestSql("title_html", "subtitle_html", "summary_html")}, title_text = null`,
        "review_text_source_sha256 = null, title_text = 'stale'"
      ]) {
        await appTransaction(
          databaseUrl,
          { ...context, authSurface: "cleanup", accountId: identity.accountId },
          (query) =>
            query({
              sql: `update public.agent_outbox_input_items set ${assignment} where input_item_id = $1`,
              values: [row.input_item_id]
            })
        );
        const changed = (await stored()).find(
          (item) => item.input_item_id === row.input_item_id
        );
        assert.deepEqual(
          projection.map((key) => changed[key]),
          [null, null, null, null]
        );
        assert.equal(await derive(), 1);
      }
      await write("<b></b>", "empty");
      assert.equal(
        (await stored()).find((item) => item.caller_item_id === "empty")
          .title_text,
        ""
      );
      // Real separate connection barriers: lock acquisition resolves before derivation starts.
      await owner.query(
        "update public.agent_outbox_input_items set review_text_source_sha256 = null where account_id = $1",
        [identity.accountId]
      );
      await owner.query(
        "insert into public.agent_outbox_input_items(account_id, caller_id, caller_item_id, caller_item_id_hash, row_type_display, row_type_icon, title_html, subtitle_html, summary_html) values ($1,$2,'other','other','Email','mail','Other &amp; account','','')",
        [other.accountId, other.callerId]
      );
      await locker.query("begin");
      await locker.query(
        "select 1 from public.agent_outbox_input_items where input_item_id = $1 for update",
        [row.input_item_id]
      );
      assert.equal(await derive(), (await stored()).length - 1);
      await locker.query("commit");
      await locker.query("begin");
      await locker.query(
        "select 1 from public.agent_outbox_accounts where account_id = $1 for update",
        [identity.accountId]
      );
      assert.equal(await derive(), 1);
      assert.equal(
        (await stored()).find((item) => item.caller_item_id === "empty")
          .title_text,
        ""
      );
      await locker.query("commit");
      assert.equal(
        (
          await owner.query(
            "select title_text from public.agent_outbox_input_items where account_id = $1",
            [other.accountId]
          )
        ).rows[0].title_text,
        null
      );
      // More than a run's cap; a second-batch error must roll back only that batch.
      await owner.query(
        `insert into public.agent_outbox_input_items(account_id, caller_id, caller_item_id, caller_item_id_hash, row_type_display, row_type_icon, title_html, subtitle_html, summary_html)
      select $1,$2,'bound-' || n,'bound-' || n,'Email','mail','Bound &amp; row','','' from generate_series(1,1001) n`,
        [identity.accountId, identity.callerId]
      );
      const snapshot = canonical(await stored());
      let batches = 0;
      let committed = 0;
      await assert.rejects(
        deriveReviewSearchTextForAccount({
          connectionString: databaseUrl,
          accountId: identity.accountId,
          ...context,
          onCommitted: (count) => {
            committed += count;
          },
          runTransaction: (url, ctx, cb) =>
            appTransaction(url, ctx, async (query) => {
              const result = await cb(query);
              if (++batches === 2)
                throw new Error("injected later batch failure");
              return result;
            })
        }),
        /injected later batch failure/
      );
      assert.equal(committed, 100);
      assert.equal(
        (await stored()).filter(
          (item) => item.review_text_source_sha256 === null
        ).length,
        901
      );
      assert.equal(await derive(), 901);
      await owner.query(
        "update public.agent_outbox_input_items set review_text_source_sha256 = null where account_id = $1 and caller_item_id like 'bound-%'",
        [identity.accountId]
      );
      assert.equal(await derive(), 1000);
      assert.equal(await derive(), 1);
      assert.equal(await derive(), 0);
      assert.deepEqual(canonical(await stored()), snapshot);
    } finally {
      await locker.query("rollback");
      await locker.end();
      try {
        await owner.query(
          "delete from public.agent_outbox_accounts where account_id = any($1::uuid[])",
          [[identity.accountId, other.accountId]]
        );
        await owner.query(
          "delete from public.agent_outbox_users where user_id = $1",
          [userId]
        );
      } finally {
        await owner.end();
      }
    }
  }
);
