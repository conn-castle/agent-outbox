import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../src/server/human-action-form.ts";
import {
  humanReviewAccountBannerInTransaction,
  humanReviewDetailInTransaction,
  humanReviewDetailStatement,
  humanReviewListInTransaction,
  humanReviewListStatement
} from "../src/server/human-review.ts";
import { humanBrowserFixtureEnabled } from "../src/server/human-review-fixture.ts";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

/** @type {import("../src/server/authorization.ts").AuthorizedHumanAccountContext} */
const context = {
  surface: "human",
  accountId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  role: "owner"
};
const inputItemId = "00000000-0000-4000-8000-000000000003";
const callerId = "00000000-0000-4000-8000-000000000005";
const outputResultId = "00000000-0000-4000-8000-000000000004";

test("human review list statement scopes rows by account and supports focused filters", () => {
  const statement = humanReviewListStatement(context, {
    status: "pending",
    search: "Acme",
    sort: "priority",
    limit: 25
  });

  assert.deepEqual(statement.values, [
    context.accountId,
    "pending",
    "%Acme%",
    25
  ]);
  assert.match(statement.sql, /from public\.agent_outbox_input_items i/);
  assert.match(statement.sql, /join public\.agent_outbox_callers c/);
  assert.match(
    statement.sql,
    /left join public\.agent_outbox_output_results o/
  );
  assert.match(statement.sql, /left join lateral/);
  assert.match(statement.sql, /action\.popup_kind = 'none'/);
  assert.match(statement.sql, /where i\.account_id = \$1/);
  assert.match(statement.sql, /i\.status = \$2/);
  assert.match(statement.sql, /i\.title_html ilike \$3/);
  assert.match(statement.sql, /case i\.priority/);
});

test("human review list shapes caller affordances and output read state", async () => {
  const query = fakeQuery([
    [
      reviewRow({
        status: "answered",
        answered_at: "2026-07-01T12:00:00.000Z",
        output_result_id: "00000000-0000-4000-8000-000000000004",
        output_action_value: "approve",
        output_answered_at: "2026-07-01T12:00:00.000Z",
        output_first_read_at: null,
        output_read_count: 0
      })
    ]
  ]);

  const rows = await humanReviewListInTransaction(query, context, {
    status: "all"
  });

  assert.deepEqual(rows, [
    {
      inputItemId,
      callerItemId: "caller-item-1",
      status: "answered",
      priority: "high",
      currentRevision: 2,
      rowType: { display: "Email Draft", icon: "mail" },
      rowAccentColor: "#2563eb",
      titleHtml: "<strong>Title</strong>",
      subtitleHtml: "Subtitle",
      cornerHtml: "2 min",
      summaryHtml: "Summary",
      cardVisual: { kind: "pill", payload: { text: "Needs review" } },
      skipDisabled: false,
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T11:00:00.000Z",
      answeredAt: "2026-07-01T12:00:00.000Z",
      caller: {
        callerId: "00000000-0000-4000-8000-000000000005",
        displayName: "Steward Email",
        slug: "steward-email",
        revoked: false
      },
      bulkActions: [
        {
          displayOrder: 0,
          display: "Approve",
          icon: "check",
          value: "approve"
        }
      ],
      output: {
        outputResultId: "00000000-0000-4000-8000-000000000004",
        actionValue: "approve",
        answeredAt: "2026-07-01T12:00:00.000Z",
        firstReadAt: null,
        readCount: 0,
        undoEligible: true
      }
    }
  ]);
});

test("human review detail lazily shapes links actions options and answerable states", async () => {
  const query = fakeQuery([
    [reviewRow({ details_html: "<p>Details</p>" })],
    [
      {
        display_order: 0,
        display: "Open source",
        icon: "external-link",
        url: "https://example.com/source"
      }
    ],
    [
      {
        input_action_id: "action-1",
        display_order: 0,
        display: "Approve",
        icon: "check",
        action_value: "approve",
        overflow: false,
        popup_kind: "none",
        popup_payload: {}
      },
      {
        input_action_id: "action-2",
        display_order: 1,
        display: "Upload",
        icon: "upload",
        action_value: "upload",
        overflow: true,
        popup_kind: "file_upload",
        popup_payload: {}
      }
    ],
    [
      {
        input_action_id: "action-1",
        display_order: 0,
        display: "Approve",
        option_value: "approve",
        icon: "check"
      }
    ]
  ]);

  const detail = await humanReviewDetailInTransaction(
    query,
    context,
    inputItemId
  );

  assert.equal(detail?.detailsHtml, "<p>Details</p>");
  assert.deepEqual(detail?.linkButtons, [
    {
      displayOrder: 0,
      display: "Open source",
      icon: "external-link",
      url: "https://example.com/source"
    }
  ]);
  assert.deepEqual(detail?.actions, [
    {
      displayOrder: 0,
      display: "Approve",
      icon: "check",
      value: "approve",
      overflow: false,
      popupKind: "none",
      popupPayload: {},
      answerable: true,
      options: [
        {
          displayOrder: 0,
          display: "Approve",
          value: "approve",
          icon: "check"
        }
      ]
    },
    {
      displayOrder: 1,
      display: "Upload",
      icon: "upload",
      value: "upload",
      overflow: true,
      popupKind: "file_upload",
      popupPayload: {},
      answerable: false,
      options: []
    }
  ]);
  assert.deepEqual(
    query.calls[0],
    humanReviewDetailStatement(context, inputItemId)
  );
});

test("human review detail returns null for cross-account or missing rows", async () => {
  const query = fakeQuery([[]]);

  const detail = await humanReviewDetailInTransaction(
    query,
    context,
    inputItemId
  );

  assert.equal(detail, null);
  assert.deepEqual(query.calls[0].values, [context.accountId, inputItemId]);
});

test("human account banner metadata reuses account status shaping under human account context", async () => {
  const query = fakeQuery([
    [
      {
        account_id: context.accountId,
        label: "Review account",
        tier: "hosted_free",
        billing_status: "not_applicable",
        billing_grace_ends_at: null
      }
    ],
    [{ non_file_stored_bytes: "100", overall_stored_bytes: "100" }],
    []
  ]);

  const banner = await humanReviewAccountBannerInTransaction(query, context);

  assert.equal(banner.ok, true);
  assert.equal(banner.ok ? banner.data.account_id : null, context.accountId);
  assert.equal(banner.ok ? banner.data.file_upload_enabled : null, false);
  assert.deepEqual(query.calls[0].values, [context.accountId]);
});

test("browser fixture bypass requires test environment and explicit fixture gate", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    AGENT_OUTBOX_BROWSER_FIXTURE: process.env.AGENT_OUTBOX_BROWSER_FIXTURE
  };

  try {
    delete process.env.APP_ENV;
    delete process.env.AGENT_OUTBOX_BROWSER_FIXTURE;
    assert.equal(humanBrowserFixtureEnabled(), false);

    setEnv("APP_ENV", "test");
    delete process.env.AGENT_OUTBOX_BROWSER_FIXTURE;
    assert.equal(humanBrowserFixtureEnabled(), false);

    setEnv("APP_ENV", "development");
    setEnv("AGENT_OUTBOX_BROWSER_FIXTURE", "1");
    assert.equal(humanBrowserFixtureEnabled(), false);

    setEnv("APP_ENV", "test");
    setEnv("NODE_ENV", "production");
    setEnv("AGENT_OUTBOX_BROWSER_FIXTURE", "1");
    assert.equal(humanBrowserFixtureEnabled(), false);

    setEnv("NODE_ENV", "test");
    setEnv("AGENT_OUTBOX_BROWSER_FIXTURE", "1");
    assert.equal(humanBrowserFixtureEnabled(), true);
  } finally {
    restoreEnv(previous);
  }
});

test("human action form parser rejects malformed hidden fields before database writes", () => {
  const validAnswer = answerForm();
  assert.deepEqual(parseHumanAnswerForm(validAnswer), {
    ok: true,
    inputItemId,
    callerId,
    expectedRevision: 2,
    actionValue: "approve",
    response: { kind: "free_text", text: "Approved with one edit." }
  });

  const invalidAnswer = answerForm();
  invalidAnswer.set("inputItemId", "not-a-uuid");
  assert.deepEqual(parseHumanAnswerForm(invalidAnswer), { ok: false });

  const invalidPopup = answerForm();
  invalidPopup.set("popupKind", "file_upload");
  assert.deepEqual(parseHumanAnswerForm(invalidPopup), { ok: false });

  const invalidDate = answerForm();
  invalidDate.set("popupKind", "date_picker");
  invalidDate.set("response.mode", "datetime");
  invalidDate.set("response.display_timezone", "UTC");
  assert.deepEqual(parseHumanAnswerForm(invalidDate), { ok: false });

  const localDateTime = answerForm();
  localDateTime.set("actionValue", "pick_datetime");
  localDateTime.set("popupKind", "date_picker");
  localDateTime.set("response.mode", "datetime");
  localDateTime.set("response.display_timezone", "UTC");
  localDateTime.set("response.value_local", "2026-07-16T09:30");
  assert.deepEqual(parseHumanAnswerForm(localDateTime), {
    ok: true,
    inputItemId,
    callerId,
    expectedRevision: 2,
    actionValue: "pick_datetime",
    response: {
      kind: "date_picker",
      mode: "datetime",
      value_utc: "2026-07-16T09:30:00.000Z",
      display_timezone: "UTC"
    }
  });

  const newYorkDateTime = answerForm();
  newYorkDateTime.set("actionValue", "pick_datetime");
  newYorkDateTime.set("popupKind", "date_picker");
  newYorkDateTime.set("response.mode", "datetime");
  newYorkDateTime.set("response.display_timezone", "America/New_York");
  newYorkDateTime.set("response.value_local", "2026-01-15T09:30");
  assert.deepEqual(parseHumanAnswerForm(newYorkDateTime), {
    ok: true,
    inputItemId,
    callerId,
    expectedRevision: 2,
    actionValue: "pick_datetime",
    response: {
      kind: "date_picker",
      mode: "datetime",
      value_utc: "2026-01-15T14:30:00.000Z",
      display_timezone: "America/New_York"
    }
  });

  const impossibleDateTime = answerForm();
  impossibleDateTime.set("popupKind", "date_picker");
  impossibleDateTime.set("response.mode", "datetime");
  impossibleDateTime.set("response.display_timezone", "UTC");
  impossibleDateTime.set("response.value_local", "2026-02-30T09:30");
  assert.deepEqual(parseHumanAnswerForm(impossibleDateTime), { ok: false });

  const impossibleTimezone = answerForm();
  impossibleTimezone.set("popupKind", "date_picker");
  impossibleTimezone.set("response.mode", "datetime");
  impossibleTimezone.set("response.display_timezone", "Not/AZone");
  impossibleTimezone.set("response.value_local", "2026-07-16T09:30");
  assert.deepEqual(parseHumanAnswerForm(impossibleTimezone), { ok: false });

  const dstGap = answerForm();
  dstGap.set("popupKind", "date_picker");
  dstGap.set("response.mode", "datetime");
  dstGap.set("response.display_timezone", "America/New_York");
  dstGap.set("response.value_local", "2026-03-08T02:30");
  assert.deepEqual(parseHumanAnswerForm(dstGap), { ok: false });

  const validBulk = new FormData();
  validBulk.set("bulkActionValue", "approve");
  validBulk.append(
    "bulkItem",
    JSON.stringify({
      inputItemId,
      callerId,
      expectedRevision: 2
    })
  );
  assert.deepEqual(parseBulkHumanAnswersForm(validBulk), {
    ok: true,
    actionValue: "approve",
    items: [{ inputItemId, callerId, expectedRevision: 2 }]
  });

  const invalidBulk = bulkForm();
  invalidBulk.append("bulkItem", JSON.stringify({ inputItemId: "bad" }));
  assert.deepEqual(parseBulkHumanAnswersForm(invalidBulk), { ok: false });

  const validUndo = new FormData();
  validUndo.set("inputItemId", inputItemId);
  validUndo.set("callerId", callerId);
  validUndo.set("outputResultId", outputResultId);
  assert.deepEqual(parseUndoHumanAnswerForm(validUndo), {
    ok: true,
    inputItemId,
    callerId,
    outputResultId
  });

  const invalidUndo = undoForm();
  invalidUndo.set("outputResultId", "not-a-uuid");
  assert.deepEqual(parseUndoHumanAnswerForm(invalidUndo), { ok: false });
});

function answerForm() {
  const formData = new FormData();
  formData.set("inputItemId", inputItemId);
  formData.set("callerId", callerId);
  formData.set("expectedRevision", "2");
  formData.set("actionValue", "approve");
  formData.set("popupKind", "free_text");
  formData.set("response.text", "Approved with one edit.");
  return formData;
}

function bulkForm() {
  const formData = new FormData();
  formData.set("bulkActionValue", "approve");
  formData.append(
    "bulkItem",
    JSON.stringify({
      inputItemId,
      callerId,
      expectedRevision: 2
    })
  );
  return formData;
}

function undoForm() {
  const formData = new FormData();
  formData.set("inputItemId", inputItemId);
  formData.set("callerId", callerId);
  formData.set("outputResultId", outputResultId);
  return formData;
}

/**
 * @param {Partial<QueryResultRow>} overrides
 * @returns {QueryResultRow}
 */
function reviewRow(overrides = {}) {
  return {
    input_item_id: inputItemId,
    caller_item_id: "caller-item-1",
    status: "pending",
    priority: "high",
    current_revision: 2,
    row_type_display: "Email Draft",
    row_type_icon: "mail",
    row_accent_color: "#2563eb",
    title_html: "<strong>Title</strong>",
    subtitle_html: "Subtitle",
    corner_html: "2 min",
    summary_html: "Summary",
    details_html: null,
    card_visual_kind: "pill",
    card_visual_payload: { text: "Needs review" },
    skip_disabled: false,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T11:00:00.000Z",
    answered_at: null,
    caller_id: "00000000-0000-4000-8000-000000000005",
    caller_display_name: "Steward Email",
    caller_slug: "steward-email",
    caller_revoked_at: null,
    output_result_id: null,
    output_action_value: null,
    output_answered_at: null,
    output_first_read_at: null,
    output_read_count: null,
    bulk_actions: [
      {
        displayOrder: 0,
        display: "Approve",
        icon: "check",
        value: "approve"
      }
    ],
    ...overrides
  };
}

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

/**
 * @param {Record<string, string | undefined>} previous
 */
function restoreEnv(previous) {
  for (const [name, value] of Object.entries(previous)) {
    setEnv(name, value);
  }
}

/**
 * @param {string} name
 * @param {string | undefined} value
 */
function setEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
