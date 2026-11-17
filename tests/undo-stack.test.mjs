import assert from "node:assert/strict";
import test from "node:test";

import {
  heldUndoTargets,
  offeredUndoEntry,
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

test("a confirmed answer keeps Undo only for answers the reported rows still hold", () => {
  // A's output was read, which Undo finds out when pressed; B was undone and
  // answered again elsewhere; C was acknowledged and is gone.
  assert.deepEqual(
    heldUndoTargets(
      [target("A"), target("B"), target("C"), target("D")],
      state(
        reported("A", "read"),
        reported("B", "answered again"),
        reported("C", "gone"),
        reported("D", "unread")
      )
    ),
    [target("A"), target("D")]
  );
});
