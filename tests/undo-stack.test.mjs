import assert from "node:assert/strict";
import test from "node:test";

import {
  offeredUndoEntry,
  removeUndoEntry,
  removeUndoTargets,
  settleUndoEntry
} from "../src/components/human/undo-stack.ts";

/** @typedef {import("../src/components/human/undo-stack.ts").UndoEntry} UndoEntry */

/** @param {string} letter */
const target = (letter) => ({
  inputItemId: `item-${letter}`,
  callerId: "caller-1",
  outputResultId: `output-${letter}`
});

/**
 * A confirmed answer entry whose undo is in flight.
 * @param {string} id
 * @param {...string} letters
 * @returns {UndoEntry}
 */
function undoingEntry(id, ...letters) {
  return {
    id,
    actionLabel: "Approve",
    inputItemIds: letters.map((letter) => `item-${letter}`),
    targets: letters.map(target),
    rowSnapshots: /** @type {UndoEntry["rowSnapshots"]} */ (
      letters.map((letter) => ({ inputItemId: `item-${letter}` }))
    ),
    undoRequested: false,
    undoing: true
  };
}

/**
 * The state an undo response reports for one item.
 * @param {string} letter
 * @param {"restored" | "unread" | "read" | "answered again" | "gone"} outcome
 */
function reported(letter, outcome) {
  const inputItemId = `item-${letter}`;
  if (outcome === "gone") return { inputItemId, row: null };
  if (outcome === "restored") {
    return {
      inputItemId,
      row: { inputItemId, status: "pending", output: null }
    };
  }
  return {
    inputItemId,
    row: {
      inputItemId,
      status: "answered",
      output: {
        outputResultId:
          outcome === "answered again" ? "output-later" : `output-${letter}`,
        undoEligible: outcome !== "read"
      }
    }
  };
}

/** @param {...ReturnType<typeof reported>} items */
const state = (...items) =>
  /** @type {import("../src/shared/human-mutation.ts").HumanMutationState} */ (
    /** @type {unknown} */ ({ asOf: "150", items })
  );

test("a completed undo leaves the stack and the answer before it is offered", () => {
  const stack = [undoingEntry("first", "A"), undoingEntry("second", "B", "C")];
  stack[0].undoing = false;
  const settled = settleUndoEntry(
    stack,
    "second",
    state(reported("B", "restored"), reported("C", "restored"))
  );
  assert.deepEqual(
    settled.map((entry) => entry.id),
    ["first"]
  );
  assert.equal(offeredUndoEntry(settled)?.id, "first");
});

test("a partial undo keeps offering the answers the server still holds unread", () => {
  const settled = settleUndoEntry(
    [undoingEntry("bulk", "A", "B", "C")],
    "bulk",
    state(
      reported("A", "restored"),
      reported("B", "unread"),
      reported("C", "unread")
    )
  );
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0].inputItemIds, ["item-B", "item-C"]);
  assert.deepEqual(settled[0].targets, [target("B"), target("C")]);
  assert.deepEqual(
    settled[0].rowSnapshots.map((row) => row.inputItemId),
    ["item-B", "item-C"]
  );
  // Offered again, so one more press finishes the undo.
  assert.equal(offeredUndoEntry(settled)?.id, "bulk");
});

test("an answer undone from History leaves the stack, and only that answer", () => {
  const stack = [
    { ...undoingEntry("single", "A"), undoing: false },
    { ...undoingEntry("bulk", "B", "C"), undoing: false }
  ];
  // History names the item and the output it undoes.
  const narrowed = removeUndoTargets(stack, ["item-B"], "output-B");
  assert.deepEqual(
    narrowed.map((entry) => [entry.id, entry.inputItemIds]),
    [
      ["single", ["item-A"]],
      ["bulk", ["item-C"]]
    ]
  );
  assert.deepEqual(narrowed[1].targets, [target("C")]);
  assert.deepEqual(
    narrowed[1].rowSnapshots.map((row) => row.inputItemId),
    ["item-C"]
  );
  // An output that is not the one on the stack is a later answer of the item:
  // the stack's own answer was not the one undone.
  assert.deepEqual(removeUndoTargets(stack, ["item-B"], "output-later"), stack);
  // Without an output id, every answer of the item goes, and an entry left
  // empty goes with it.
  assert.deepEqual(
    removeUndoTargets(stack, ["item-A"], null).map((entry) => entry.id),
    ["bulk"]
  );
  assert.deepEqual(
    removeUndoEntry(stack, "single").map((entry) => entry.id),
    ["bulk"]
  );
});

test("answers that can no longer be undone leave the stack", () => {
  const settled = settleUndoEntry(
    [undoingEntry("bulk", "A", "B", "C", "D")],
    "bulk",
    state(
      reported("A", "read"),
      reported("B", "answered again"),
      reported("C", "gone"),
      reported("D", "unread")
    )
  );
  assert.deepEqual(settled[0].inputItemIds, ["item-D"]);
  assert.deepEqual(
    settleUndoEntry(
      [undoingEntry("single", "A")],
      "single",
      state(reported("A", "read"))
    ),
    []
  );
});
