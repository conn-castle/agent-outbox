import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BULK_HUMAN_ANSWER_ITEMS,
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../src/server/human-action-form.ts";
import {
  humanReviewAccountBannerInTransaction,
  humanReviewDetailInTransaction,
  humanReviewDetailStatement,
  humanReviewListInTransaction,
  humanReviewPageInTransaction,
  humanReviewListStatement
} from "../src/server/human-review.ts";
import {
  browserFixtureReviewPage,
  browserFixtureStoryboardDetails,
  browserFixtureStoryboardScenarios,
  humanBrowserFixtureEnabled
} from "../src/server/human-review-fixture.ts";
import { browserFixtureDesignReviewDetails } from "../src/server/human-review-design-fixture.ts";
import {
  isSupportedColor,
  SUPPORTED_LUCIDE_ICON_NAMES
} from "../src/shared/input-schema-rules.ts";
import {
  humanReviewHref,
  humanReviewViewFromRecord,
  humanReviewViewFromSearchParams,
  writeHumanReviewView
} from "../src/shared/human-review-view.ts";
import {
  accountHasHostedBilling,
  accountStorageLabel
} from "../src/shared/account-display.ts";

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

test("human review view parsing and links share canonical defaults", () => {
  assert.deepEqual(humanReviewViewFromRecord(undefined), {
    search: "",
    status: "pending",
    sort: "priority",
    page: 1
  });

  const params = new URLSearchParams(
    "search=%20invoice%20&status=answered&sort=updated_at&page=3"
  );
  const parsed = humanReviewViewFromSearchParams(params);
  assert.deepEqual(parsed, {
    search: "invoice",
    status: "answered",
    sort: "updated_at",
    page: 3
  });
  assert.deepEqual(
    parsed,
    humanReviewViewFromRecord({
      search: " invoice ",
      status: "answered",
      sort: "updated_at",
      page: "3"
    })
  );
  assert.equal(
    humanReviewHref(parsed, inputItemId),
    `/human?search=invoice&status=answered&sort=updated_at&page=3&item=${inputItemId}`
  );
  assert.equal(
    humanReviewHref(parsed, inputItemId, "attach_signed_nda"),
    `/human?search=invoice&status=answered&sort=updated_at&page=3&item=${inputItemId}&compose=attach_signed_nda`
  );

  const retained = new URLSearchParams("fixture_signup=1&status=all&page=7");
  writeHumanReviewView(retained, {
    search: "",
    status: "pending",
    sort: "priority",
    page: 1
  });
  assert.equal(retained.toString(), "fixture_signup=1");

  for (const invalidPage of ["0", "-1", "1.5", "not-a-page"]) {
    assert.equal(
      humanReviewViewFromRecord({ page: invalidPage }).page,
      1,
      invalidPage
    );
  }
});

test("fixture resolved items leave pending and appear as answered history", () => {
  /** @type {import("../src/shared/human-review-view.ts").HumanReviewView} */
  const pendingView = {
    search: "",
    status: "pending",
    sort: "priority",
    page: 1
  };
  const target = browserFixtureReviewPage(pendingView).rows[0];
  assert.ok(target);
  const resolvedItems = {
    [target.inputItemId]: {
      actionDisplay: "Approve",
      callerId: target.caller.callerId,
      answeredAt: "2026-08-19T01:00:00.000Z"
    }
  };

  const pending = browserFixtureReviewPage(pendingView, { resolvedItems });
  assert.equal(
    pending.rows.some((row) => row.inputItemId === target.inputItemId),
    false
  );

  const answered = browserFixtureReviewPage(
    { ...pendingView, status: "answered" },
    { resolvedItems }
  );
  const historyRow = answered.rows.find(
    (row) => row.inputItemId === target.inputItemId
  );
  assert.ok(historyRow);
  assert.equal(historyRow.status, "answered");
  assert.equal(historyRow.output?.actionDisplay, "Approve");
});

test("account banner distinguishes zero, unlimited, and self-hosted billing", () => {
  assert.equal(accountStorageLabel(0, 0), "0 byte capacity");
  assert.equal(accountStorageLabel(42, null), "Unlimited");
  assert.equal(accountStorageLabel(25, 100), "25%");
  assert.equal(
    accountHasHostedBilling({
      tier: "self_hosted",
      billing_status: "not_applicable"
    }),
    false
  );
  assert.equal(
    accountHasHostedBilling({
      tier: "hosted_free",
      billing_status: "not_applicable"
    }),
    false
  );
  assert.equal(
    accountHasHostedBilling({ tier: "hosted_paid", billing_status: "active" }),
    true
  );
});

/** @param {string[]} values */
function sortedSet(values) {
  return [...new Set(values)].sort();
}

/**
 * @param {import("../src/server/human-answer.ts").JsonValue} value
 * @returns {Record<string, import("../src/server/human-answer.ts").JsonValue>}
 */
function jsonObject(value) {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
  return value;
}

/** @param {import("../src/server/human-review.ts").HumanReviewListRow["cardVisual"]} visual */
function pillVisualIcons(visual) {
  if (visual?.kind !== "pill") return [];
  const icon = jsonObject(visual.payload).icon;
  return typeof icon === "string" ? [icon] : [];
}

/** @param {import("../src/server/human-review.ts").HumanReviewListRow["cardVisual"]} visual */
function numericVisualPercents(visual) {
  if (visual?.kind !== "numeric_bar" && visual?.kind !== "progress_ring") {
    return [];
  }
  const payload = jsonObject(visual.payload);
  const value = payload.value;
  const min = payload.min_value;
  const max = payload.max_value;
  if (
    typeof value !== "number" ||
    typeof min !== "number" ||
    typeof max !== "number"
  ) {
    return [];
  }
  return [((value - min) / (max - min)) * 100];
}

test("design review fixture preserves the exported mock rows and controls", () => {
  const details = browserFixtureDesignReviewDetails();

  assert.deepEqual(
    details.map((detail) => detail.titleHtml),
    [
      "Re: Order 1042 delivery date and support coverage",
      "Review the homepage headline",
      "Choose a release environment",
      "Choose checks to rerun",
      "Set the invoice due date",
      "Schedule the autumn campaign",
      "Attach the signed vendor NDA"
    ]
  );
  assert.deepEqual(
    details.map((detail) => detail.actions.map((action) => action.display)),
    [
      ["Approve to send", "Reject"],
      ["Request changes", "Approve copy"],
      ["Choose environment", "Hold release", "Cancel release"],
      ["Select checks", "Rerun all", "Cancel rerun"],
      ["Set due date", "Use Net 30", "Hold invoice"],
      ["Schedule launch", "Launch now", "Cancel campaign"],
      ["Upload signed PDF", "Request new signature", "Cancel onboarding"]
    ]
  );
  assert.deepEqual(
    details.map((detail) => detail.linkButtons.map((link) => link.display)),
    [
      ["Open conversation", "View customer record"],
      [],
      ["View build"],
      [],
      [],
      [],
      ["View unsigned NDA"]
    ]
  );
  assert.ok(details[0].cardVisual);
  assert.equal(jsonObject(details[0].cardVisual.payload).display, "92");
  assert.equal(jsonObject(details[0].cardVisual.payload).unit, "%");
});

test("browser fixture storyboards cover every declared review renderer option and product use case", () => {
  const details = browserFixtureStoryboardDetails();
  const scenarios = browserFixtureStoryboardScenarios();
  assert.equal(details.length, 10);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.inputItemId),
    details.map((detail) => detail.inputItemId)
  );
  assert.equal(
    new Set(scenarios.map((scenario) => scenario.callerItemId)).size,
    10
  );

  assert.deepEqual(sortedSet(details.map((detail) => detail.priority)), [
    "high",
    "low",
    "normal",
    "urgent"
  ]);
  assert.deepEqual(sortedSet(details.map((detail) => detail.status)), [
    "answered",
    "pending"
  ]);
  assert.deepEqual(
    sortedSet(
      details.flatMap((detail) =>
        detail.actions.map((action) => action.popupKind)
      )
    ),
    [
      "date_picker",
      "file_upload",
      "free_text",
      "multi_select",
      "none",
      "single_select"
    ]
  );
  assert.deepEqual(
    sortedSet(
      details.flatMap((detail) =>
        detail.actions
          .filter((action) => action.popupKind === "date_picker")
          .map((action) => jsonObject(action.popupPayload).mode)
          .filter((mode) => typeof mode === "string")
      )
    ),
    ["date", "datetime"]
  );
  assert.deepEqual(
    sortedSet(
      details
        .map((detail) => detail.cardVisual?.kind)
        .filter((kind) => kind !== undefined)
    ),
    ["numeric_bar", "pill", "progress_ring"]
  );
  assert.ok(details.some((detail) => detail.cardVisual === null));

  const numericVisuals = details.flatMap((detail) =>
    detail.cardVisual?.kind === "numeric_bar" ||
    detail.cardVisual?.kind === "progress_ring"
      ? [jsonObject(detail.cardVisual.payload)]
      : []
  );
  assert.ok(numericVisuals.some((payload) => typeof payload.unit === "string"));
  assert.ok(numericVisuals.some((payload) => payload.unit == null));

  const progressColors = details.flatMap((detail) =>
    detail.cardVisual?.kind === "progress_ring"
      ? [jsonObject(detail.cardVisual.payload).color]
      : []
  );
  assert.ok(progressColors.some((color) => color == null));
  assert.ok(
    details.some(
      (detail) =>
        detail.cardVisual?.kind === "progress_ring" &&
        detail.cardVisual.payload.unit === "checks"
    )
  );
  assert.ok(
    progressColors.some(
      (color) => typeof color === "string" && isSupportedColor(color)
    )
  );
  assert.ok(
    progressColors.every(
      (color) =>
        color == null || (typeof color === "string" && isSupportedColor(color))
    )
  );

  const pillIcons = details.flatMap((detail) =>
    detail.cardVisual?.kind === "pill"
      ? [jsonObject(detail.cardVisual.payload).icon]
      : []
  );
  assert.ok(pillIcons.some((icon) => typeof icon === "string"));
  assert.ok(pillIcons.some((icon) => icon == null));

  const freeTextPayloads = details.flatMap((detail) =>
    detail.actions
      .filter((action) => action.popupKind === "free_text")
      .map((action) => jsonObject(action.popupPayload))
  );
  assert.ok(freeTextPayloads.some((payload) => payload.multiline === true));
  assert.ok(freeTextPayloads.some((payload) => payload.multiline === false));
  assert.ok(
    freeTextPayloads.some(
      (payload) => typeof payload.default_value === "string"
    )
  );
  assert.ok(freeTextPayloads.some((payload) => payload.default_value == null));

  const datePayloads = details.flatMap((detail) =>
    detail.actions
      .filter((action) => action.popupKind === "date_picker")
      .map((action) => jsonObject(action.popupPayload))
  );
  for (const optionalDateField of [
    "placeholder",
    "display_timezone",
    "min_value",
    "max_value"
  ]) {
    assert.ok(
      datePayloads.some((payload) => payload[optionalDateField] == null),
      `${optionalDateField} null variation`
    );
    assert.ok(
      datePayloads.some(
        (payload) => typeof payload[optionalDateField] === "string"
      ),
      `${optionalDateField} string variation`
    );
  }

  const filePayloads = details.flatMap((detail) =>
    detail.actions
      .filter((action) => action.popupKind === "file_upload")
      .map((action) => jsonObject(action.popupPayload))
  );
  assert.ok(
    filePayloads.some((payload) => Array.isArray(payload.accept_mime_types))
  );
  assert.ok(filePayloads.some((payload) => payload.accept_mime_types == null));

  const optionIcons = details.flatMap((detail) =>
    detail.actions.flatMap((action) =>
      action.options.map((option) => option.icon)
    )
  );
  assert.ok(optionIcons.some((icon) => typeof icon === "string"));
  assert.ok(optionIcons.some((icon) => icon === null));

  const usedIcons = sortedSet(
    details.flatMap((detail) => [
      detail.rowType.icon,
      ...detail.actions.flatMap((action) => [
        action.icon,
        ...action.options
          .map((option) => option.icon)
          .filter((icon) => typeof icon === "string")
      ]),
      ...detail.bulkActions.map((action) => action.icon),
      ...detail.linkButtons.map((link) => link.icon),
      ...pillVisualIcons(detail.cardVisual)
    ])
  );
  /** @type {Set<string>} */
  const supportedIconNames = new Set(SUPPORTED_LUCIDE_ICON_NAMES);
  assert.deepEqual(
    usedIcons.filter((icon) => supportedIconNames.has(icon)),
    [...SUPPORTED_LUCIDE_ICON_NAMES].sort()
  );
  assert.ok(usedIcons.every((icon) => supportedIconNames.has(icon)));

  const primaryActionCounts = details.map(
    (detail) => detail.bulkActions.filter((action) => !action.overflow).length
  );
  assert.ok(primaryActionCounts.some((count) => count === 1));
  assert.ok(primaryActionCounts.some((count) => count === 2));
  assert.ok(primaryActionCounts.some((count) => count > 2));
  assert.ok(details.some((detail) => detail.linkButtons.length === 0));
  assert.ok(details.some((detail) => detail.linkButtons.length === 1));
  assert.ok(details.some((detail) => detail.linkButtons.length > 1));
  assert.ok(details.some((detail) => detail.detailsHtml === null));
  assert.ok(details.some((detail) => detail.detailsHtml !== null));
  assert.ok(details.some((detail) => detail.cornerHtml === null));
  assert.ok(details.some((detail) => detail.cornerHtml !== null));
  assert.ok(details.some((detail) => detail.skipDisabled));
  assert.ok(details.some((detail) => !detail.skipDisabled));
  assert.ok(
    details.some((detail) => detail.actions.some((action) => action.overflow))
  );
  assert.ok(
    details.some((detail) =>
      detail.actions.some(
        (action) => action.tone === "success" && action.style === "solid"
      )
    )
  );
  assert.ok(
    details.some((detail) =>
      detail.actions.some((action) => !action.answerable)
    )
  );
  assert.ok(details.some((detail) => detail.rowAccentColor === null));
  assert.ok(
    details.some(
      (detail) =>
        detail.rowAccentColor !== null &&
        isSupportedColor(detail.rowAccentColor)
    )
  );
  assert.ok(
    details.every(
      (detail) =>
        detail.rowAccentColor === null ||
        isSupportedColor(detail.rowAccentColor)
    )
  );

  const outputs = details.flatMap((detail) =>
    detail.output ? [detail.output] : []
  );
  assert.ok(
    outputs.some((output) => output.undoEligible && !output.firstReadAt)
  );
  assert.ok(
    outputs.some((output) => !output.undoEligible && output.firstReadAt)
  );

  const numericPercents = details.flatMap((detail) =>
    numericVisualPercents(detail.cardVisual)
  );
  assert.ok(numericPercents.some((percent) => percent < 50));
  assert.ok(numericPercents.some((percent) => percent >= 50 && percent < 75));
  assert.ok(numericPercents.some((percent) => percent >= 75));

  const useCases = scenarios.map((scenario) => scenario.useCase).join("\n");
  for (const requiredUseCase of [
    /Email draft approval/,
    /Email archive labeling/,
    /LinkedIn connection request approval/,
    /X post draft approval/,
    /Financial categorization/,
    /ambiguity/,
    /failed automated check/,
    /SMS reply/
  ]) {
    assert.match(useCases, requiredUseCase);
  }
});

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
    25,
    0
  ]);
  assert.match(statement.sql, /from public\.agent_outbox_input_items i/);
  assert.match(statement.sql, /join public\.agent_outbox_callers c/);
  assert.match(
    statement.sql,
    /left join public\.agent_outbox_output_results o/
  );
  assert.match(statement.sql, /left join lateral/);
  assert.match(statement.sql, /'popupKind', action\.popup_kind/);
  assert.match(statement.sql, /'overflow', action\.overflow/);
  assert.match(
    statement.sql,
    /from public\.agent_outbox_input_link_buttons link/
  );
  assert.match(statement.sql, /where i\.account_id = \$1/);
  assert.match(statement.sql, /i\.status = \$2/);
  assert.match(
    statement.sql,
    /regexp_replace\(i\.title_html, '<\[\^>\]\*>', ' ', 'g'\) ilike \$3/
  );
  assert.match(statement.sql, /or i\.caller_item_id ilike \$3/);
  assert.match(statement.sql, /or i\.row_type_display ilike \$3/);
  assert.match(statement.sql, /case i\.priority/);
});

test("human review page trims its private sentinel and reports another page", async () => {
  const databaseRows = Array.from({ length: 101 }, (_, index) =>
    reviewRow({
      input_item_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    })
  );
  const query = fakeQuery([databaseRows]);

  const page = await humanReviewPageInTransaction(query, context, {
    status: "pending",
    offset: 100
  });

  assert.equal(page.rows.length, 100);
  assert.equal(page.hasNext, true);
  const call = query.calls[0];
  assert.ok(call);
  assert.ok(call.values);
  assert.deepEqual(call.values.slice(-2), [101, 100]);
  assert.match(call.sql, /order by i\.updated_at desc, i\.input_item_id/);
  assert.match(call.sql, /limit \$3\s+offset \$4/);
});

test("human review search treats LIKE metacharacters as literal text", () => {
  const statement = humanReviewListStatement(context, {
    search: "50%_off!"
  });

  assert.deepEqual(statement.values, [
    context.accountId,
    "%50!%!_off!!%",
    50,
    0
  ]);
  assert.equal(statement.sql.match(/ilike \$2 escape '!'/g)?.length, 6);
});

test("human review list shapes caller affordances and output read state", async () => {
  const query = fakeQuery([
    [
      reviewRow({
        status: "answered",
        answered_at: "2026-07-01T12:00:00.000Z",
        output_result_id: "00000000-0000-4000-8000-000000000004",
        output_action_value: "approve",
        output_action_display: "Approve",
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
      rowAccentColor: "blue",
      titleHtml: "<strong>Title</strong>",
      subtitleHtml: "Subtitle",
      cornerHtml: "2 min",
      summaryHtml: "Summary",
      cardVisual: {
        kind: "pill",
        payload: { text: "Needs review", icon: null, color: "blue" }
      },
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
          value: "approve",
          popupKind: "none",
          overflow: false
        }
      ],
      linkButtons: [],
      hasOverflowActions: false,
      output: {
        outputResultId: "00000000-0000-4000-8000-000000000004",
        actionValue: "approve",
        actionDisplay: "Approve",
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
        action_tone: "success",
        action_style: "solid",
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
    ],
    [
      {
        account_id: context.accountId,
        label: "Review account",
        tier: "hosted_paid",
        billing_status: "active",
        billing_grace_ends_at: null
      }
    ],
    [{ non_file_stored_bytes: "100", overall_stored_bytes: "100" }],
    []
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
      tone: "success",
      style: "solid",
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
      popupPayload: { label: "", accept_mime_types: null },
      answerable: true,
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

  const emptyTextAnswer = answerForm();
  emptyTextAnswer.set("response.text", "");
  assert.deepEqual(parseHumanAnswerForm(emptyTextAnswer), {
    ok: true,
    inputItemId,
    callerId,
    expectedRevision: 2,
    actionValue: "approve",
    response: { kind: "free_text", text: "" }
  });

  const invalidAnswer = answerForm();
  invalidAnswer.set("inputItemId", "not-a-uuid");
  assert.deepEqual(parseHumanAnswerForm(invalidAnswer), { ok: false });

  const invalidPopup = answerForm();
  invalidPopup.set("popupKind", "file_upload");
  assert.deepEqual(parseHumanAnswerForm(invalidPopup), { ok: false });

  const validFileUpload = answerForm();
  const uploadedFile = new File(["file bytes"], "receipt.pdf", {
    type: "application/pdf"
  });
  validFileUpload.set("actionValue", "upload");
  validFileUpload.set("popupKind", "file_upload");
  validFileUpload.delete("response.text");
  validFileUpload.set("response.file", uploadedFile);
  assert.deepEqual(parseHumanAnswerForm(validFileUpload), {
    ok: true,
    inputItemId,
    callerId,
    expectedRevision: 2,
    actionValue: "upload",
    response: { kind: "file_upload", file: uploadedFile }
  });

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

  const localDateTimeWithSeconds = answerForm();
  localDateTimeWithSeconds.set("actionValue", "pick_datetime");
  localDateTimeWithSeconds.set("popupKind", "date_picker");
  localDateTimeWithSeconds.set("response.mode", "datetime");
  localDateTimeWithSeconds.set("response.display_timezone", "UTC");
  localDateTimeWithSeconds.set("response.value_local", "2026-07-16T09:30:15");
  assert.deepEqual(parseHumanAnswerForm(localDateTimeWithSeconds), {
    ok: true,
    inputItemId,
    callerId,
    expectedRevision: 2,
    actionValue: "pick_datetime",
    response: {
      kind: "date_picker",
      mode: "datetime",
      value_utc: "2026-07-16T09:30:15.000Z",
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

  const duplicateBulk = bulkForm();
  duplicateBulk.append(
    "bulkItem",
    JSON.stringify({
      inputItemId,
      callerId,
      expectedRevision: 2
    })
  );
  assert.deepEqual(parseBulkHumanAnswersForm(duplicateBulk), { ok: false });

  const oversizedBulk = new FormData();
  oversizedBulk.set("bulkActionValue", "approve");
  for (let index = 0; index <= MAX_BULK_HUMAN_ANSWER_ITEMS; index += 1) {
    oversizedBulk.append(
      "bulkItem",
      JSON.stringify({
        inputItemId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        callerId,
        expectedRevision: 2
      })
    );
  }
  assert.deepEqual(parseBulkHumanAnswersForm(oversizedBulk), { ok: false });

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
    row_accent_color: "blue",
    title_html: "<strong>Title</strong>",
    subtitle_html: "Subtitle",
    corner_html: "2 min",
    summary_html: "Summary",
    details_html: null,
    card_visual_kind: "pill",
    card_visual_payload: { text: "Needs review", icon: null, color: "blue" },
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
    output_action_display: null,
    output_answered_at: null,
    output_first_read_at: null,
    output_read_count: null,
    bulk_actions: [
      {
        displayOrder: 0,
        display: "Approve",
        icon: "check",
        value: "approve",
        popupKind: "none",
        overflow: false
      }
    ],
    link_buttons: [],
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
