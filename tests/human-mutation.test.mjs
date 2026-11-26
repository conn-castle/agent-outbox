import assert from "node:assert/strict";
import test from "node:test";

import {
  HumanMutationError,
  isHumanMutationResult,
  synchronizeHumanMutation
} from "../src/components/human/human-mutation-client.ts";
import { compareAsOf, isAsOf } from "../src/shared/human-mutation.ts";

const itemId = "00000000-0000-4000-8000-000000000501";
const otherItemId = "00000000-0000-4000-8000-000000000502";

/** One state entry per requested item, as every success must carry. */
function stateFor(/** @type {string[]} */ inputItemIds) {
  return {
    asOf: "1794830400000000",
    items: inputItemIds.map((inputItemId) => ({ inputItemId, row: null }))
  };
}

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
  // A bulk answer stopped part-way names the answers it committed, which
  // must be undo targets for items of this request.
  const interrupted = {
    ok: false,
    operation: "bulk-answer",
    message: "Bulk action interrupted: 1 answered, 1 not confirmed.",
    inputItemIds: [itemId, "00000000-0000-4000-8000-000000000502"],
    code: "temporary_unavailable"
  };
  const committed = {
    inputItemId: itemId,
    callerId: "00000000-0000-4000-8000-000000000503",
    outputResultId: "00000000-0000-4000-8000-000000009999"
  };
  assert.equal(
    isHumanMutationResult({ ...interrupted, undo: [committed] }),
    true
  );
  for (const undo of [
    committed,
    [{ ...committed, outputResultId: undefined }],
    [{ ...committed, inputItemId: "00000000-0000-4000-8000-000000000599" }]
  ]) {
    assert.equal(isHumanMutationResult({ ...interrupted, undo }), false);
  }
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
      },
      state: stateFor([itemId])
    }),
    true
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "answer",
      message: "Done.",
      inputItemIds: [itemId],
      state: stateFor([itemId])
    }),
    false
  );
  const undoTarget = {
    inputItemId: itemId,
    callerId: "00000000-0000-4000-8000-000000000503",
    outputResultId: "00000000-0000-4000-8000-000000009999"
  };
  // An answer's undo target is for the item that was answered.
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "answer",
      message: "Done.",
      inputItemIds: [itemId],
      undo: { ...undoTarget, inputItemId: otherItemId },
      state: stateFor([itemId])
    }),
    false
  );
  const bulkAnswer = {
    ok: true,
    operation: "bulk-answer",
    message: "Bulk action complete: 1 answered, 1 failed.",
    inputItemIds: [itemId, otherItemId],
    answered: 1,
    answeredInputItemIds: [itemId],
    failed: 1,
    undo: [undoTarget],
    state: stateFor([itemId, otherItemId])
  };
  assert.equal(isHumanMutationResult(bulkAnswer), true);
  // Every answered item needs its undo target, or the action cannot be undone.
  assert.equal(isHumanMutationResult({ ...bulkAnswer, undo: [] }), false);
  assert.equal(
    isHumanMutationResult({
      ...bulkAnswer,
      undo: [{ ...undoTarget, inputItemId: otherItemId }]
    }),
    false
  );
  assert.equal(
    isHumanMutationResult({
      ok: true,
      operation: "bulk-answer",
      message: "Bulk action complete: 1 answered, 1 failed.",
      inputItemIds: [itemId],
      state: stateFor([itemId])
    }),
    false
  );
  const undo = {
    ok: true,
    operation: "undo",
    message: "Undo complete: 1 restored, 1 failed.",
    inputItemIds: [itemId, otherItemId],
    restoredInputItemIds: [itemId],
    failed: 1,
    state: stateFor([itemId, otherItemId])
  };
  assert.equal(isHumanMutationResult(undo), true);
  assert.equal(
    isHumanMutationResult({
      ...undo,
      message: "Undone.",
      inputItemIds: [itemId],
      failed: 0,
      state: stateFor([itemId])
    }),
    true
  );
  // A successful undo names the items it restored, and at least one.
  assert.equal(
    isHumanMutationResult({ ...undo, restoredInputItemIds: undefined }),
    false
  );
  assert.equal(
    isHumanMutationResult({ ...undo, restoredInputItemIds: [], failed: 2 }),
    false
  );
  assert.equal(
    isHumanMutationResult({
      ...undo,
      restoredInputItemIds: ["00000000-0000-4000-8000-000000000599"]
    }),
    false
  );
  assert.equal(isHumanMutationResult({ ...undo, failed: 0 }), false);
  assert.equal(
    isHumanMutationResult({ ...undo, inputItemIds: [itemId, itemId] }),
    false
  );
});

test("isHumanMutationResult requires the items' state on every success", () => {
  const answer = {
    ok: true,
    operation: "answer",
    message: "Done.",
    inputItemIds: [itemId],
    undo: {
      inputItemId: itemId,
      callerId: "00000000-0000-4000-8000-000000000503",
      outputResultId: "00000000-0000-4000-8000-000000009999"
    },
    state: stateFor([itemId])
  };
  assert.equal(isHumanMutationResult(answer), true);
  assert.equal(
    isHumanMutationResult({
      ...answer,
      state: {
        ...answer.state,
        items: [{ inputItemId: itemId, row: { inputItemId: itemId } }]
      }
    }),
    true
  );
  // Without state the client could only guess what the answer changed.
  assert.equal(isHumanMutationResult({ ...answer, state: undefined }), false);
  for (const state of [
    { ...answer.state, asOf: "soon" },
    { ...answer.state, asOf: 1794830400000000 },
    { ...answer.state, items: [] },
    stateFor([otherItemId]),
    stateFor([itemId, otherItemId]),
    {
      ...answer.state,
      items: [{ inputItemId: itemId, row: { inputItemId: otherItemId } }]
    },
    { ...answer.state, items: [{ inputItemId: itemId }] }
  ]) {
    assert.equal(
      isHumanMutationResult({ ...answer, state }),
      false,
      JSON.stringify(state)
    );
  }

  // A rejection may report the rejected items' state, but need not.
  const rejection = {
    ok: false,
    operation: "answer",
    code: "input_not_pending",
    message: "Human answer creation requires a pending input item.",
    inputItemIds: [itemId]
  };
  assert.equal(isHumanMutationResult(rejection), true);
  assert.equal(
    isHumanMutationResult({ ...rejection, state: stateFor([itemId]) }),
    true
  );
  assert.equal(
    isHumanMutationResult({ ...rejection, state: stateFor([otherItemId]) }),
    false
  );
});

test("a response cut off before its result is retried under the same mutation id", async (t) => {
  const answer = {
    ok: true,
    operation: "answer",
    message: "Done.",
    inputItemIds: [itemId],
    undo: {
      inputItemId: itemId,
      callerId: "00000000-0000-4000-8000-000000000503",
      outputResultId: "00000000-0000-4000-8000-000000009999"
    },
    state: stateFor([itemId])
  };
  /** @type {FormDataEntryValue[]} */
  const mutationIds = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (
      /** @type {unknown} */ _url,
      /** @type {{ body: FormData }} */ init
    ) => {
      mutationIds.push(init.body.get("mutationId") ?? "");
      // The first response ends mid-body: the answer may have been committed.
      return mutationIds.length === 1
        ? new Response('{"ok":true,"operation":"ans', { status: 200 })
        : Response.json(answer);
    }
  );
  assert.deepEqual(
    await synchronizeHumanMutation("answer", new FormData()),
    answer
  );
  assert.equal(mutationIds.length, 2);
  assert.equal(mutationIds[0], mutationIds[1]);
  assert.match(String(mutationIds[0]), /^[0-9a-f-]{36}$/);
});

test("a successful response without a usable result is retried, not reported as a failure", async (t) => {
  const undone = {
    ok: true,
    operation: "undo",
    message: "Undone.",
    inputItemIds: [itemId],
    restoredInputItemIds: [itemId],
    failed: 0,
    state: stateFor([itemId])
  };
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    // A 200 whose body is not a result: the undo may have been applied.
    return Response.json(attempts === 1 ? { ok: true } : undone);
  });
  assert.deepEqual(
    await synchronizeHumanMutation("undo", new FormData()),
    undone
  );
  assert.equal(attempts, 2);
});

test("a result that reports success under a failure status is retried, not reported as a failure", async (t) => {
  const undone = {
    ok: true,
    operation: "undo",
    message: "Undone.",
    inputItemIds: [itemId],
    restoredInputItemIds: [itemId],
    failed: 0,
    state: stateFor([itemId])
  };
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    // The body says the undo was applied and the status says it was not.
    return Response.json(undone, { status: attempts === 1 ? 409 : 200 });
  });
  assert.deepEqual(
    await synchronizeHumanMutation("undo", new FormData()),
    undone
  );
  assert.equal(attempts, 2);
});

test("a session refusal on a retry leaves the first attempt's outcome unconfirmed", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    // The first attempt may have committed before its response was lost.
    if (attempts === 1) throw new TypeError("network down");
    return Response.json({}, { status: 401 });
  });
  await assert.rejects(
    synchronizeHumanMutation("answer", new FormData()),
    (error) =>
      error instanceof HumanMutationError &&
      error.unconfirmed &&
      /session expired/i.test(error.message)
  );
  assert.equal(attempts, 2);
});

test("a refusal on a retry settles nothing about earlier attempts, and keeps what they committed and reported", async (t) => {
  const committed = {
    inputItemId: itemId,
    callerId: "00000000-0000-4000-8000-000000000503",
    outputResultId: "00000000-0000-4000-8000-000000009999"
  };
  const failure = {
    ok: false,
    operation: "bulk-answer",
    inputItemIds: [itemId, "00000000-0000-4000-8000-000000000502"]
  };
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    // The first attempt answered one item and stopped at the next.
    return attempts === 1
      ? Response.json(
          {
            ...failure,
            code: "temporary_unavailable",
            message: "Temporarily unavailable.",
            undo: [committed],
            state: stateFor(failure.inputItemIds)
          },
          { status: 503 }
        )
      : Response.json(
          {
            ...failure,
            code: "account_membership_required",
            message: "Account access is required."
          },
          { status: 409 }
        );
  });
  await assert.rejects(
    synchronizeHumanMutation("bulk-answer", new FormData()),
    (error) => {
      assert.ok(error instanceof HumanMutationError);
      // The refusal carries a result, yet the first attempt's answer stands.
      assert.equal(error.result?.code, "account_membership_required");
      assert.equal(error.unconfirmed, true);
      assert.deepEqual(error.committed, [committed]);
      // So do the rows it reported, which the refusal does not repeat.
      assert.deepEqual(error.state, stateFor(failure.inputItemIds));
      return true;
    }
  );
  assert.equal(attempts, 2);
});

test("a successful repeat keeps the answers an earlier attempt reported", async (t) => {
  const callerId = "00000000-0000-4000-8000-000000000503";
  const ids = [itemId, otherItemId, "00000000-0000-4000-8000-000000000504"];
  const [first, second] = ids.map((inputItemId, index) => ({
    inputItemId,
    callerId,
    outputResultId: `00000000-0000-4000-8000-00000000999${index}`
  }));
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return attempts === 1
      ? // The first attempt answered the first item and stopped at the next.
        Response.json(
          {
            ok: false,
            operation: "bulk-answer",
            code: "temporary_unavailable",
            message: "Temporarily unavailable.",
            inputItemIds: ids,
            undo: [first],
            state: stateFor(ids)
          },
          { status: 503 }
        )
      : // Its caller then acknowledged that answer, so the repeat finds no
        // such item. It answers the second and cannot answer the third.
        Response.json({
          ok: true,
          operation: "bulk-answer",
          message: "Bulk action complete: 1 answered, 2 failed.",
          inputItemIds: ids,
          answered: 1,
          answeredInputItemIds: [second.inputItemId],
          failed: 2,
          undo: [second],
          state: stateFor(ids)
        });
  });
  const result = await synchronizeHumanMutation("bulk-answer", new FormData());
  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    ok: true,
    operation: "bulk-answer",
    message: "Bulk action complete: 2 answered, 1 failed.",
    inputItemIds: ids,
    answered: 2,
    answeredInputItemIds: [first.inputItemId, second.inputItemId],
    failed: 1,
    undo: [first, second],
    state: stateFor(ids)
  });
});

test("a mutation id is a canonical UUID without crypto.randomUUID", async (t) => {
  // Outside a secure context the browser has no crypto.randomUUID.
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis.crypto, "randomUUID");
  });
  /** @type {FormDataEntryValue[]} */
  const mutationIds = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (
      /** @type {unknown} */ _url,
      /** @type {{ body: FormData }} */ init
    ) => {
      mutationIds.push(init.body.get("mutationId") ?? "");
      return Response.json({
        ok: false,
        operation: "answer",
        code: "input_not_pending",
        message: "Already answered.",
        inputItemIds: [itemId]
      });
    }
  );
  for (let request = 0; request < 2; request += 1) {
    await assert.rejects(synchronizeHumanMutation("answer", new FormData()));
  }
  assert.equal(new Set(mutationIds).size, 2);
  for (const mutationId of mutationIds) {
    assert.match(
      String(mutationId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  }
});

test("a server error the server words as a refusal is reported at once", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    // The route answers a configuration failure with 503; nothing committed.
    return Response.json(
      {
        ok: false,
        operation: "answer",
        code: "database_configuration_missing",
        message: "Human account database configuration is unavailable.",
        inputItemIds: [itemId]
      },
      { status: 503 }
    );
  });
  await assert.rejects(
    synchronizeHumanMutation("answer", new FormData()),
    (error) => {
      assert.ok(error instanceof HumanMutationError);
      assert.equal(error.unconfirmed, false);
      assert.equal(error.result?.code, "database_configuration_missing");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("a request the server refused is reported at once, not retried", async (t) => {
  const fetched = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("Forbidden", { status: 403 })
  );
  await assert.rejects(
    synchronizeHumanMutation("answer", new FormData()),
    (error) => error instanceof HumanMutationError && !error.unconfirmed
  );
  assert.equal(fetched.mock.callCount(), 1);
});

test("as-of tokens order numerically, including beyond double precision", () => {
  assert.equal(compareAsOf("9", "10"), -1);
  assert.equal(compareAsOf("10", "9"), 1);
  assert.equal(compareAsOf("1794830400000000", "1794830400000000"), 0);
  assert.equal(compareAsOf("9007199254740993", "9007199254740992"), 1);
  assert.equal(isAsOf("1794830400000000"), true);
  for (const invalid of ["", "-1", "1.5", "1e3", " 1", 1, null, undefined]) {
    assert.equal(isAsOf(invalid), false, String(invalid));
  }
});
