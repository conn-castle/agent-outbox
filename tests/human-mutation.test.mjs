import assert from "node:assert/strict";
import test from "node:test";

import {
  isHumanMutationResult,
  laterAnswerRetiresEarlierUndo
} from "../src/components/human/human-mutation-client.ts";

const itemId = "00000000-0000-4000-8000-000000000501";

test("isHumanMutationResult requires operation-specific success and failure fields", () => {
  assert.equal(
    isHumanMutationResult({
      ok: false,
      operation: "bulk-answer",
      message: "Bulk action failed: 2 not answered.",
      inputItemIds: [itemId],
      code: "bulk_answer_failed"
    }),
    true
  );
  assert.equal(
    isHumanMutationResult({
      ok: false,
      operation: "bulk-answer",
      message: "Bulk action failed: 2 not answered.",
      inputItemIds: [itemId]
    }),
    false
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "answer",
      message: "Done.",
      inputItemIds: [itemId],
      undo: {
        inputItemId: itemId,
        callerId: "00000000-0000-4000-8000-000000000503",
        outputResultId: "00000000-0000-4000-8000-000000009999"
      }
    }),
    true
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "answer",
      message: "Done.",
      inputItemIds: [itemId]
    }),
    false
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "bulk-answer",
      message: "Bulk action complete: 1 answered, 1 failed.",
      inputItemIds: [itemId],
      answered: 1,
      answeredInputItemIds: [itemId],
      failed: 1
    }),
    true
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "bulk-answer",
      message: "Bulk action complete: 1 answered, 1 failed.",
      inputItemIds: [itemId]
    }),
    false
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "undo",
      message: "Undone.",
      inputItemIds: [itemId]
    }),
    true
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "undo",
      message: "Undone.",
      inputItemIds: [itemId, itemId]
    }),
    false
  );
});

const undoneId = "00000000-0000-4000-8000-000000000501";
const otherId = "00000000-0000-4000-8000-000000000502";

test("later single-answer retires an overlapping undo when the canonical row is absent", () => {
  assert.equal(
    laterAnswerRetiresEarlierUndo({
      laterOperation: "answer",
      laterInputItemIds: [undoneId],
      laterCanonicalRows: [undefined],
      undoInputItemIds: [undoneId]
    }),
    true
  );
});

test("later single-answer does not retire an overlapping undo while that row is still pending", () => {
  assert.equal(
    laterAnswerRetiresEarlierUndo({
      laterOperation: "answer",
      laterInputItemIds: [undoneId],
      laterCanonicalRows: [{ status: "pending" }],
      undoInputItemIds: [undoneId]
    }),
    false
  );
});

test("later bulk-answer does not retire an overlapping undo when that canonical row is absent", () => {
  assert.equal(
    laterAnswerRetiresEarlierUndo({
      laterOperation: "bulk-answer",
      laterInputItemIds: [undoneId, otherId],
      laterCanonicalRows: [undefined, { status: "answered" }],
      undoInputItemIds: [undoneId]
    }),
    false
  );
});

test("later bulk-answer retires an overlapping undo only when that row is present and not pending", () => {
  assert.equal(
    laterAnswerRetiresEarlierUndo({
      laterOperation: "bulk-answer",
      laterInputItemIds: [undoneId, otherId],
      laterCanonicalRows: [{ status: "answered" }, undefined],
      undoInputItemIds: [undoneId]
    }),
    true
  );
  assert.equal(
    laterAnswerRetiresEarlierUndo({
      laterOperation: "bulk-answer",
      laterInputItemIds: [undoneId, otherId],
      laterCanonicalRows: [{ status: "pending" }, undefined],
      undoInputItemIds: [undoneId]
    }),
    false
  );
});
