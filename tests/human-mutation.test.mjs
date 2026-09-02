import assert from "node:assert/strict";
import test from "node:test";

import { isHumanMutationResult } from "../src/components/human/human-mutation-client.ts";

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
