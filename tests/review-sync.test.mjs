import assert from "node:assert/strict";
import test from "node:test";

import {
  itemIdsNotPending,
  projectReview,
  recordItemStates,
  reviewDetailSuperseded
} from "../src/components/human/review-sync.ts";
import { humanReviewViewFromRecord } from "../src/shared/human-review-view.ts";

/** @typedef {import("../src/server/human-review.ts").HumanReviewListRow} Row */
/** @typedef {import("../src/components/human/review-sync.ts").ReviewItemStates} ItemStates */

const pendingView = humanReviewViewFromRecord(undefined);
const answeredView = humanReviewViewFromRecord({ status: "answered" });

/**
 * A pending row. Later letters sort later in the default (newest first) view.
 * @param {string} letter
 * @param {Partial<Row>} [changes]
 * @returns {Row}
 */
function row(letter, changes = {}) {
  const minute = String(60 - letter.charCodeAt(0) + 64).padStart(2, "0");
  return {
    inputItemId: `item-${letter}`,
    callerItemId: `caller-item-${letter}`,
    status: "pending",
    priority: "normal",
    currentRevision: 1,
    rowType: { display: "Approval", icon: "check" },
    rowAccentColor: null,
    titleHtml: `Review ${letter}`,
    subtitleHtml: "",
    cornerHtml: null,
    cardTime: null,
    summaryHtml: "",
    cardVisual: null,
    skipDisabled: false,
    createdAt: `2026-11-16T10:${minute}:00.000Z`,
    updatedAt: `2026-11-16T10:${minute}:00.000Z`,
    answeredAt: null,
    caller: {
      callerId: "caller-1",
      displayName: "Caller",
      slug: null,
      revoked: false
    },
    output: null,
    bulkActions: [],
    ...changes
  };
}

/** @param {Row} pending @returns {Row} */
function answered(pending) {
  return {
    ...pending,
    status: "answered",
    answeredAt: "2026-11-16T11:00:00.000Z",
    output: {
      outputResultId: `output-${pending.inputItemId}`,
      actionValue: "approve",
      actionDisplay: "Approve",
      answeredAt: "2026-11-16T11:00:00.000Z",
      firstReadAt: null,
      readCount: 0,
      undoEligible: true
    }
  };
}

/**
 * The item states left by mutation responses, applied in order.
 * @param {...[asOf: string, rows: (Row | string)[]]} responses
 * @returns {ItemStates}
 */
function statesFrom(...responses) {
  /** @type {ItemStates} */
  let states = new Map();
  for (const [asOf, rows] of responses) {
    states = recordItemStates(
      states,
      {
        asOf,
        items: rows.map((entry) =>
          typeof entry === "string"
            ? { inputItemId: entry, row: null }
            : { inputItemId: entry.inputItemId, row: entry }
        )
      },
      "0"
    );
  }
  return states;
}

/** @param {{ rows: Row[] }} projection */
const ids = (projection) => projection.rows.map((item) => item.inputItemId);

test("a page with nothing newer is shown exactly as the server ordered it", () => {
  // Server order is not always the comparator's order; it must survive.
  const page = { rows: [row("C"), row("A"), row("B")], asOf: "100" };
  const projection = projectReview(page, new Map(), [], pendingView);
  assert.deepEqual(ids(projection), ["item-C", "item-A", "item-B"]);
  assert.equal(projection.lockedIds.size, 0);
});

test("an answer hides its row as soon as the person acts", () => {
  const page = { rows: [row("A"), row("B"), row("C")], asOf: "100" };
  const projection = projectReview(
    page,
    new Map(),
    [{ operation: "answer", inputItemIds: ["item-B"], rowSnapshots: [] }],
    pendingView
  );
  assert.deepEqual(ids(projection), ["item-A", "item-C"]);
});

test("a confirmed answer stays hidden while the page is older than the response", () => {
  const stalePage = { rows: [row("A"), row("B")], asOf: "100" };
  const states = statesFrom(["150", [answered(row("B"))]]);
  assert.deepEqual(ids(projectReview(stalePage, states, [], pendingView)), [
    "item-A"
  ]);
});

test("a page at least as new as a response overrides it", () => {
  const states = statesFrom(["150", [answered(row("B"))]]);
  // The item was undone elsewhere, so a newer page lists it as pending again.
  const restored = row("B", { currentRevision: 2 });
  for (const asOf of ["150", "151"]) {
    const projection = projectReview(
      { rows: [row("A"), restored], asOf },
      states,
      [],
      pendingView
    );
    assert.deepEqual(projection.rows, [row("A"), restored], asOf);
  }
});

test("an undo in flight shows the row in its sorted place, locked", () => {
  const page = { rows: [row("A"), row("C")], asOf: "200" };
  const states = statesFrom(["150", [answered(row("B"))]]);
  const projection = projectReview(
    page,
    states,
    [{ operation: "undo", inputItemIds: ["item-B"], rowSnapshots: [row("B")] }],
    pendingView
  );
  assert.deepEqual(ids(projection), ["item-A", "item-B", "item-C"]);
  assert.deepEqual([...projection.lockedIds], ["item-B"]);
});

test("a confirmed undo restores the server's row even when the page predates it", () => {
  const stalePage = { rows: [row("A"), row("C")], asOf: "100" };
  const restored = row("B", { currentRevision: 2 });
  const states = statesFrom(["150", [answered(row("B"))]], ["180", [restored]]);
  const projection = projectReview(stalePage, states, [], pendingView);
  assert.deepEqual(projection.rows, [row("A"), restored, row("C")]);
  assert.equal(projection.lockedIds.size, 0);
});

test("a newer page without the restored row removes it again", () => {
  const states = statesFrom(["180", [row("B", { currentRevision: 2 })]]);
  // Answered again from another device after the undo.
  const page = { rows: [row("A"), row("C")], asOf: "190" };
  assert.deepEqual(ids(projectReview(page, states, [], pendingView)), [
    "item-A",
    "item-C"
  ]);
});

test("an older response arriving late does not replace a newer one", () => {
  const restored = row("B", { currentRevision: 2 });
  const states = statesFrom(["180", [restored]], ["150", [answered(row("B"))]]);
  assert.deepEqual(states.get("item-B"), { row: restored, asOf: "180" });
});

test("a rejected answer applies the state the server reported instead", () => {
  // Answered in another tab: the rejection carries the answered row.
  const page = { rows: [row("A"), row("B")], asOf: "100" };
  const states = statesFrom(["150", [answered(row("B"))]]);
  assert.deepEqual(ids(projectReview(page, states, [], pendingView)), [
    "item-A"
  ]);
});

test("a newer row is placed again only when it sorts differently", () => {
  // Replaced by its caller before the answer arrived: the rejection carries
  // the new pending row, which now outranks the row above it.
  const page = { rows: [row("C"), row("A"), row("B")], asOf: "100" };
  const raised = statesFrom(["150", [row("B", { priority: "urgent" })]]);
  assert.deepEqual(ids(projectReview(page, raised, [], pendingView)), [
    "item-B",
    "item-A",
    "item-C"
  ]);
  // A new revision that sorts the same leaves the server's order alone.
  const revised = statesFrom(["150", [row("B", { currentRevision: 2 })]]);
  const projection = projectReview(page, revised, [], pendingView);
  assert.deepEqual(ids(projection), ["item-C", "item-A", "item-B"]);
  assert.equal(projection.rows[2].currentRevision, 2);
});

test("an item the server reports gone is removed", () => {
  const page = { rows: [row("A"), row("B")], asOf: "100" };
  const states = statesFrom(["150", ["item-B"]]);
  assert.deepEqual(ids(projectReview(page, states, [], pendingView)), [
    "item-A"
  ]);
});

test("a restored row outside the current filters is not shown", () => {
  const urgentOnly = humanReviewViewFromRecord({ priority: "urgent" });
  const page = { rows: [row("A", { priority: "urgent" })], asOf: "100" };
  const states = statesFrom(["150", [row("B")]]);
  assert.deepEqual(ids(projectReview(page, states, [], urgentOnly)), [
    "item-A"
  ]);
});

test("a just-answered item appears in History before its page catches up", () => {
  const states = statesFrom(["150", [answered(row("B"))]]);
  const projection = projectReview(
    { rows: [], asOf: "100" },
    states,
    [],
    answeredView
  );
  assert.deepEqual(ids(projection), ["item-B"]);
});

test("an undo from History locks the answered row until the server answers", () => {
  const page = { rows: [answered(row("B"))], asOf: "100" };
  const projection = projectReview(
    page,
    new Map(),
    [{ operation: "undo", inputItemIds: ["item-B"], rowSnapshots: [] }],
    answeredView
  );
  assert.deepEqual(ids(projection), ["item-B"]);
  assert.deepEqual([...projection.lockedIds], ["item-B"]);
});

test("a partly applied bulk answer hides only the items the server answered", () => {
  const page = { rows: [row("A"), row("B"), row("C")], asOf: "100" };
  // B was changed by its caller first, so the server left it pending.
  const kept = row("B", { currentRevision: 2 });
  const states = statesFrom([
    "150",
    [answered(row("A")), kept, answered(row("C"))]
  ]);
  assert.deepEqual(projectReview(page, states, [], pendingView).rows, [kept]);
});

test("an open detail is superseded by a mutation in flight or a newer state", () => {
  const detail = row("B");
  /** @type {import("../src/components/human/review-sync.ts").UnsettledReviewMutation[]} */
  const inFlight = [
    { operation: "answer", inputItemIds: ["item-B"], rowSnapshots: [] }
  ];
  assert.equal(reviewDetailSuperseded(detail, "100", new Map(), []), false);
  assert.equal(
    reviewDetailSuperseded(detail, "100", new Map(), inFlight),
    true
  );
  const answeredState = statesFrom(["150", [answered(row("B"))]]);
  assert.equal(reviewDetailSuperseded(detail, "100", answeredState, []), true);
  // The same page render carried the detail, so a newer page means it is current.
  assert.equal(reviewDetailSuperseded(detail, "150", answeredState, []), false);
  assert.equal(
    reviewDetailSuperseded(detail, "100", statesFrom(["150", [row("B")]]), []),
    false
  );
  assert.equal(
    reviewDetailSuperseded(
      detail,
      "100",
      statesFrom(["150", [row("B", { currentRevision: 2 })]]),
      []
    ),
    true
  );
  assert.equal(
    reviewDetailSuperseded(detail, "100", statesFrom(["150", ["item-B"]]), []),
    true
  );

  // A caller read leaves the status and revision alone but ends Undo.
  const answeredDetail = answered(row("B"));
  const read = answered(row("B"));
  Object.assign(read.output ?? {}, {
    firstReadAt: "2026-11-16T11:05:00.000Z",
    readCount: 1,
    undoEligible: false
  });
  assert.equal(
    reviewDetailSuperseded(
      answeredDetail,
      "100",
      statesFrom(["150", [answered(row("B"))]]),
      []
    ),
    false
  );
  assert.equal(
    reviewDetailSuperseded(
      answeredDetail,
      "100",
      statesFrom(["150", [read]]),
      []
    ),
    true
  );
});

test("only answered or missing items leave the selection", () => {
  assert.deepEqual(
    itemIdsNotPending({
      asOf: "150",
      items: [
        { inputItemId: "item-A", row: answered(row("A")) },
        { inputItemId: "item-B", row: row("B") },
        { inputItemId: "item-C", row: null }
      ]
    }),
    ["item-A", "item-C"]
  );
});
