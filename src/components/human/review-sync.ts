import {
  compareAsOf,
  type HumanMutationOperation,
  type HumanMutationState
} from "../../shared/human-mutation.ts";
import { compareHumanReviewRows } from "../../shared/human-review-sort.ts";
import {
  humanReviewMatchesFacets,
  humanReviewMatchesSearch,
  type HumanReviewView
} from "../../shared/human-review-view.ts";
import type { HumanReviewListRow } from "../../server/human-review.ts";

// An answer no attempt confirmed: the view and page it was sent from, and
// the page shown when it settled.
export type UnconfirmedAnswer = {
  inputItemIds: string[];
  viewHref: string;
  sentAsOf: string;
  settledAsOf: string;
};

/**
 * Says which items of unconfirmed answers leave the selection now that `page`
 * is shown, and which answers keep waiting. An unconfirmed answer may have
 * committed: a page of its view, newer than the one it was sent from, that no
 * longer shows an item means the item was answered or has moved. Items still
 * shown wait for a page read after the answer settled, which settles them.
 */
export function releaseUnconfirmedAnswers(
  unconfirmed: readonly UnconfirmedAnswer[],
  page: {
    rows: readonly { inputItemId: string }[];
    asOf: string;
    viewHref: string;
  }
) {
  const shown = new Set(page.rows.map((row) => row.inputItemId));
  const released: string[] = [];
  const waiting = unconfirmed.flatMap((sent) => {
    if (
      sent.viewHref !== page.viewHref ||
      compareAsOf(page.asOf, sent.sentAsOf) <= 0
    ) {
      return [sent];
    }
    const stillShown = sent.inputItemIds.filter((id) => shown.has(id));
    released.push(...sent.inputItemIds.filter((id) => !shown.has(id)));
    return stillShown.length === 0 ||
      compareAsOf(page.asOf, sent.settledAsOf) > 0
      ? []
      : [{ ...sent, inputItemIds: stillShown }];
  });
  return { waiting, released };
}

/**
 * How the review queue shown in the browser is derived from what the server
 * has said. There are three sources, and each is trusted for exactly what it
 * states:
 *
 * - The page: the rows of the current view, as of `asOf`.
 * - Item states: one item's authoritative row from a mutation response, as of
 *   that response's `asOf`. The newer of a page and an item state wins.
 * - Unsettled mutations: what the person asked for and the server has not yet
 *   answered. They are shown on top until the response replaces them.
 *
 * Nothing here guesses a revision or infers an outcome from a row's absence.
 */

export type ReviewPage = {
  rows: HumanReviewListRow[];
  asOf: string;
};

export type ReviewItemState = {
  // Null when the item no longer exists.
  row: HumanReviewListRow | null;
  asOf: string;
};

export type ReviewItemStates = ReadonlyMap<string, ReviewItemState>;

export type UnsettledReviewMutation = {
  operation: HumanMutationOperation;
  inputItemIds: string[];
  // For an undo: the pending rows to show, locked, until the server answers.
  rowSnapshots: HumanReviewListRow[];
};

export type ReviewProjection = {
  rows: HumanReviewListRow[];
  // Shown but not actionable: an undo for them is in flight.
  lockedIds: ReadonlySet<string>;
};

// Item states the current page already reflects are only dropped beyond this
// many, so a page delivered out of order is still corrected by them.
const RETAINED_ITEM_STATES = 500;

/** Adds a mutation response's item states, keeping the newer per item. */
export function recordItemStates(
  states: ReviewItemStates,
  state: HumanMutationState,
  pageAsOf: string
): ReviewItemStates {
  const next = new Map(states);
  for (const { inputItemId, row } of state.items) {
    const known = next.get(inputItemId);
    if (known && compareAsOf(known.asOf, state.asOf) > 0) continue;
    // Re-insert so the map runs from the least to the most recently reported
    // item, and the states trimmed first are the ones reported longest ago.
    next.delete(inputItemId);
    next.set(inputItemId, { row, asOf: state.asOf });
  }
  for (const [inputItemId, known] of next) {
    if (next.size <= RETAINED_ITEM_STATES) break;
    if (compareAsOf(known.asOf, pageAsOf) <= 0) next.delete(inputItemId);
  }
  return next;
}

export function projectReview(
  page: ReviewPage,
  states: ReviewItemStates,
  unsettled: readonly UnsettledReviewMutation[],
  view: HumanReviewView
): ReviewProjection {
  const rows = new Map(page.rows.map((row) => [row.inputItemId, row]));
  let moved = false;
  const show = (row: HumanReviewListRow) => {
    const shown = rows.get(row.inputItemId);
    moved ||= !shown || compareHumanReviewRows(shown, row, view) !== 0;
    rows.set(row.inputItemId, row);
  };

  for (const [inputItemId, state] of states) {
    if (compareAsOf(state.asOf, page.asOf) <= 0) continue;
    if (state.row && reviewRowMatchesView(state.row, view)) {
      show(state.row);
    } else {
      rows.delete(inputItemId);
    }
  }

  const lockedIds = new Set<string>();
  for (const mutation of unsettled) {
    for (const inputItemId of mutation.inputItemIds) {
      if (mutation.operation !== "undo") {
        rows.delete(inputItemId);
        lockedIds.delete(inputItemId);
        continue;
      }
      lockedIds.add(inputItemId);
      const snapshot = mutation.rowSnapshots.find(
        (row) => row.inputItemId === inputItemId
      );
      if (
        snapshot &&
        !rows.has(inputItemId) &&
        reviewRowMatchesView(snapshot, view)
      ) {
        show(snapshot);
      }
    }
  }

  const projected = [...rows.values()];
  // The page arrives in server order; only a row it did not contain, or one
  // whose newer version sorts differently, needs placing.
  return {
    rows: moved
      ? projected.sort((left, right) =>
          compareHumanReviewRows(left, right, view)
        )
      : projected,
    lockedIds
  };
}

/**
 * Whether an open detail no longer describes its item: a mutation for it is
 * in flight, or the server has since reported a different state.
 */
export function reviewDetailSuperseded(
  detail: Pick<
    HumanReviewListRow,
    "inputItemId" | "status" | "currentRevision" | "output"
  >,
  pageAsOf: string,
  states: ReviewItemStates,
  unsettled: readonly UnsettledReviewMutation[]
) {
  if (
    unsettled.some((mutation) =>
      mutation.inputItemIds.includes(detail.inputItemId)
    )
  ) {
    return true;
  }
  const state = states.get(detail.inputItemId);
  if (!state || compareAsOf(state.asOf, pageAsOf) <= 0) return false;
  return (
    state.row === null ||
    state.row.status !== detail.status ||
    state.row.currentRevision !== detail.currentRevision ||
    // A caller read changes the output, and whether it can still be undone,
    // without changing the item's revision.
    state.row.output?.firstReadAt !== detail.output?.firstReadAt ||
    state.row.output?.readCount !== detail.output?.readCount
  );
}

/** The items a response reports as answered or gone. */
export function itemIdsNotPending(state: HumanMutationState) {
  return state.items
    .filter(({ row }) => row?.status !== "pending")
    .map(({ inputItemId }) => inputItemId);
}

function reviewRowMatchesView(row: HumanReviewListRow, view: HumanReviewView) {
  return (
    row.status === view.status &&
    humanReviewMatchesFacets(row, view) &&
    humanReviewMatchesSearch(row, view.search.trim())
  );
}
