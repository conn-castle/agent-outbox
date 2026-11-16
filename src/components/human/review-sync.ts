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
    // Re-insert so the map stays ordered from oldest to newest.
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
  let inserted = false;
  const show = (row: HumanReviewListRow) => {
    inserted ||= !rows.has(row.inputItemId);
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
  // The page arrives in server order; only a row it did not contain needs
  // placing.
  return {
    rows: inserted
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
    "inputItemId" | "status" | "currentRevision"
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
    state.row.currentRevision !== detail.currentRevision
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
