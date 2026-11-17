import type {
  HumanMutationState,
  HumanUndoTarget
} from "../../shared/human-mutation.ts";
import type { HumanReviewListRow } from "../../server/human-review";

// One answer action (single or bulk) that the Undo control can reverse. The
// stack is ordered by when the person acted, oldest first.
export type UndoEntry = {
  id: string;
  actionLabel: string | null;
  inputItemIds: string[];
  // Null until the server accepts the answer and returns its undo targets.
  targets: HumanUndoTarget[] | null;
  rowSnapshots: HumanReviewListRow[];
  // Undo was pressed before the answer was accepted; it starts on acceptance.
  undoRequested: boolean;
  // An undo request for this entry is in flight.
  undoing: boolean;
};

/** The entry the Undo control acts on: the most recent one not being undone. */
export function offeredUndoEntry(stack: UndoEntry[]) {
  return stack.findLast((entry) => !entry.undoing) ?? null;
}

export function removeUndoEntry(stack: UndoEntry[], entryId: string) {
  return stack.filter((entry) => entry.id !== entryId);
}

export function patchUndoEntry(
  stack: UndoEntry[],
  entryId: string,
  patch: Partial<UndoEntry>
) {
  return stack.map((entry) =>
    entry.id === entryId ? { ...entry, ...patch } : entry
  );
}

/** Records the accepted answer, keeping only the items the server answered. */
export function confirmUndoEntry(
  stack: UndoEntry[],
  entryId: string,
  targets: HumanUndoTarget[]
) {
  if (targets.length === 0) return removeUndoEntry(stack, entryId);
  const inputItemIds = targets.map((target) => target.inputItemId);
  return stack.map((entry) =>
    entry.id === entryId
      ? {
          ...entry,
          inputItemIds,
          targets,
          rowSnapshots: entry.rowSnapshots.filter((row) =>
            inputItemIds.includes(row.inputItemId)
          )
        }
      : entry
  );
}

/** The targets whose answers the reported rows still hold. */
export function heldUndoTargets(
  targets: HumanUndoTarget[],
  state: HumanMutationState
) {
  return targets.filter(
    (target) =>
      state.items.find((item) => item.inputItemId === target.inputItemId)?.row
        ?.output?.outputResultId === target.outputResultId
  );
}

/**
 * Settles an entry's undo from the rows the server reported. Answers it
 * restored, or can no longer reverse, leave the stack; answers it still holds
 * unread stay on the entry, which is offered again to finish the undo.
 */
export function settleUndoEntry(
  stack: UndoEntry[],
  entryId: string,
  state: HumanMutationState
) {
  const entry = stack.find((candidate) => candidate.id === entryId);
  const remaining = (entry?.targets ?? []).filter((target) => {
    const output = state.items.find(
      (item) => item.inputItemId === target.inputItemId
    )?.row?.output;
    return (
      output?.outputResultId === target.outputResultId && output.undoEligible
    );
  });
  return patchUndoEntry(confirmUndoEntry(stack, entryId, remaining), entryId, {
    undoing: false
  });
}

/**
 * Drops answers that were reversed (or found irreversible) outside the stack,
 * such as from History. An entry left without items is removed.
 */
export function removeUndoTargets(
  stack: UndoEntry[],
  inputItemIds: string[],
  outputResultId: string | null
) {
  return stack.flatMap((entry) => {
    if (!entry.targets) return [entry];
    const targets = entry.targets.filter(
      (target) =>
        !inputItemIds.includes(target.inputItemId) ||
        (outputResultId !== null && target.outputResultId !== outputResultId)
    );
    if (targets.length === entry.targets.length) return [entry];
    return confirmUndoEntry([entry], entry.id, targets);
  });
}
