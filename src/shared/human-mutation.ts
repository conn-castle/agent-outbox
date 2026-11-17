import type { HumanReviewListRow } from "../server/human-review.ts";

const HUMAN_MUTATION_OPERATIONS = ["answer", "bulk-answer", "undo"] as const;

export type HumanMutationOperation = (typeof HUMAN_MUTATION_OPERATIONS)[number];

export function isHumanMutationOperation(
  value: unknown
): value is HumanMutationOperation {
  return HUMAN_MUTATION_OPERATIONS.some((operation) => operation === value);
}

// The authoritative row for one item, or null when the item no longer exists.
export type HumanMutationItemState = {
  inputItemId: string;
  row: HumanReviewListRow | null;
};

/**
 * What the server knows about the mutated items, read after the mutation
 * committed. `asOf` is read from the database clock before the rows, so it is
 * a lower bound: a review page whose `asOf` is not older already reflects the
 * mutation, while a change another session committed between the token and
 * the rows can be in these rows and not yet in such a page. See `compareAsOf`.
 */
export type HumanMutationState = {
  asOf: string;
  items: HumanMutationItemState[];
};

const AS_OF_PATTERN = /^\d{1,19}$/;

export function isAsOf(value: unknown): value is string {
  return typeof value === "string" && AS_OF_PATTERN.test(value);
}

/** Negative when `left` is older than `right`, zero when equal. */
export function compareAsOf(left: string, right: string) {
  const difference = BigInt(left) - BigInt(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export type HumanMutationFailure = {
  ok: false;
  operation: HumanMutationOperation;
  code: string;
  message: string;
  inputItemIds: string[];
  failedActionKind?: "file_upload";
  // Present whenever the server could still read the items it rejected.
  state?: HumanMutationState;
  // Answers a bulk request committed before the failure that stopped it.
  undo?: HumanUndoTarget[];
};

// Identifies one answered item whose unread output can still be undone.
export type HumanUndoTarget = {
  inputItemId: string;
  callerId: string;
  outputResultId: string;
};

export type HumanAnswerMutationSuccess = {
  ok: true;
  operation: "answer";
  message: string;
  inputItemIds: [string];
  undo: HumanUndoTarget;
  state: HumanMutationState;
};

export type HumanBulkMutationSuccess = {
  ok: true;
  operation: "bulk-answer";
  message: string;
  inputItemIds: string[];
  answered: number;
  answeredInputItemIds: string[];
  failed: number;
  // One target per answered item, so the whole bulk action is one undo step.
  undo: HumanUndoTarget[];
  state: HumanMutationState;
};

export type HumanUndoMutationSuccess = {
  ok: true;
  operation: "undo";
  message: string;
  // Every requested item; restoredInputItemIds is the non-empty subset undone.
  inputItemIds: string[];
  restoredInputItemIds: string[];
  failed: number;
  state: HumanMutationState;
};

export type HumanMutationResult =
  | HumanMutationFailure
  | HumanAnswerMutationSuccess
  | HumanBulkMutationSuccess
  | HumanUndoMutationSuccess;
