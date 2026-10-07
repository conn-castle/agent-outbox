import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../src/server/human-action-form.ts";
import { validatedResponsePayload } from "../src/server/human-answer.ts";
import * as requestBody from "../src/server/request-body.ts";
import * as humanMutationResponse from "../src/server/human-mutation-response.ts";
import * as humanMutation from "../src/shared/human-mutation.ts";
import { SYSTEM_CONTRACT } from "../src/shared/system-contract.ts";
import { loadModuleForTest } from "./helpers/transpiled-module.mjs";

const origin = "https://agent-outbox.test";
const inputItemId = "00000000-0000-4000-8000-000000000003";
const callerId = "00000000-0000-4000-8000-000000000005";
const outputResultId = "00000000-0000-4000-8000-000000000004";

// Execute the real POST export, real bounded reader, native form parser, and
// actual form/response validators. Clerk, fixture readiness, correlation IDs,
// reporting, and the action services are dependency doubles: this suite proves
// transport/dispatch behavior, not database authorization or transaction effects.
function routeHarness() {
  const state = {
    userId: /** @type {string | null} */ ("signed-in-user"),
    authCalls: 0,
    fixture: false,
    reports:
      /** @type {{ error: unknown, metadata: Record<string, unknown> }[]} */ ([]),
    answers: /** @type {ReturnType<typeof parseHumanAnswerForm>[]} */ ([]),
    bulk: /** @type {ReturnType<typeof parseBulkHumanAnswersForm>[]} */ ([]),
    undo: /** @type {ReturnType<typeof parseUndoHumanAnswerForm>[]} */ ([]),
    stored: /** @type {ReturnType<typeof validatedResponsePayload>[]} */ ([]),
    failureCode: /** @type {string | null} */ (null)
  };
  /** @param {string} operation */
  function invalid(operation) {
    return {
      ok: false,
      operation,
      code: state.failureCode ?? "invalid_request",
      message: "Invalid action",
      inputItemIds: []
    };
  }
  const actions = {
    /** @param {FormData} form */
    executeHumanAnswerMutation(form) {
      const parsed = parseHumanAnswerForm(form);
      state.answers.push(parsed);
      if (!parsed.ok || state.failureCode) return invalid("answer");
      const payload = validatedResponsePayload(
        parsed.response.kind === "file_upload"
          ? {
              popupKind: "file_upload",
              popupPayload: { label: "Attach", accept_mime_types: null }
            }
          : { popupKind: "none", popupPayload: {} },
        parsed.response,
        parsed.feedback
      );
      state.stored.push(payload);
      if (!payload.ok) return invalid("answer");
      return {
        ok: true,
        operation: "answer",
        message: "Answered",
        inputItemIds: [parsed.inputItemId],
        undo: {
          inputItemId: parsed.inputItemId,
          callerId: parsed.callerId,
          outputResultId
        }
      };
    },
    /** @param {FormData} form */
    executeBulkHumanAnswersMutation(form) {
      const parsed = parseBulkHumanAnswersForm(form);
      state.bulk.push(parsed);
      if (!parsed.ok || state.failureCode) return invalid("bulk-answer");
      for (const item of parsed.items) {
        const payload = validatedResponsePayload(
          { popupKind: "none", popupPayload: {} },
          { kind: "none" },
          item.feedback
        );
        state.stored.push(payload);
        if (!payload.ok) return invalid("bulk-answer");
      }
      const ids = parsed.items.map((item) => item.inputItemId);
      return {
        ok: true,
        operation: "bulk-answer",
        message: "Answered",
        inputItemIds: ids,
        answered: ids.length,
        answeredInputItemIds: ids,
        failed: 0
      };
    },
    /** @param {FormData} form */
    executeUndoHumanAnswerMutation(form) {
      const parsed = parseUndoHumanAnswerForm(form);
      state.undo.push(parsed);
      if (!parsed.ok || state.failureCode) return invalid("undo");
      return {
        ok: true,
        operation: "undo",
        message: "Undone",
        inputItemIds: [parsed.inputItemId]
      };
    }
  };
  const dependencies = {
    "@clerk/nextjs/server": {
      auth: async () => {
        state.authCalls++;
        return { userId: state.userId };
      }
    },
    "../actions": actions,
    "../../../src/server/correlation": {
      createCorrelationId: () => "test-request"
    },
    "../../../src/server/human-review-fixture-gate": {
      humanBrowserFixtureEnabled: () => state.fixture
    },
    "../../../src/server/request-body": requestBody,
    "../../../src/server/human-mutation-response": humanMutationResponse,
    "../../../src/shared/human-mutation": humanMutation,
    "../../../src/server/sentry": {
      /** @param {unknown} error @param {Record<string, unknown>} metadata */
      reportRuntimeFailure(error, metadata) {
        state.reports.push({ error, metadata });
      }
    }
  };
  const exports =
    /** @type {{ POST: (request: Request) => Promise<Response> }} */ (
      loadModuleForTest("app/human/mutations/route.ts", {
        stubs: dependencies,
        globals: { Response, URL, Date }
      })
    );
  return { POST: exports.POST, state };
}

/** @param {string} operation */
function ordinaryForm(operation) {
  const form = new FormData();
  form.set("_operation", operation);
  form.set("noticeAction", "Approve");
  form.set("view.search", "contract review");
  form.set("view.status", "pending");
  form.set("view.priority", "high");
  form.set("view.type", "task");
  form.set("view.sort", "updated_at");
  form.set("view.dir", "desc");
  form.set("view.then", "priority");
  form.set("view.then_dir", "asc");
  form.set("view.page", "2");
  if (operation === "bulk-answer") {
    form.set("bulkActionValue", "approve");
    form.append(
      "bulkItem",
      JSON.stringify({ inputItemId, callerId, expectedRevision: 2 })
    );
    form.set(`feedback.${inputItemId}`, "Independent feedback");
  } else {
    form.set("inputItemId", inputItemId);
    form.set("callerId", callerId);
    if (operation === "undo") form.set("outputResultId", outputResultId);
    else {
      form.set("expectedRevision", "2");
      form.set("actionValue", "approve");
      form.set("popupKind", "none");
      form.set("feedback", "Approved after review");
      form.set("noticeSubject", "Contract");
      form.set("returnToQueue", "1");
    }
  }
  return form;
}

/** @param {BodyInit} body @param {Record<string, string>} [headers] */
function request(body, headers = {}) {
  return new Request(
    `${origin}/human/mutations`,
    /** @type {RequestInit} */ (
      /** @type {unknown} */ ({
        method: "POST",
        body,
        headers: { origin, ...headers },
        duplex: "half"
      })
    )
  );
}

/**
 * @param {Response} response
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
async function assertMutationFailure(response, status, code, message) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    await response.text(),
    JSON.stringify({
      ok: false,
      operation: "answer",
      code,
      message,
      inputItemIds: []
    })
  );
}

for (const operation of ["answer", "bulk-answer", "undo"]) {
  test(`POST preserves ordinary ${operation} multipart dispatch and response envelope`, async () => {
    const { POST, state } = routeHarness();
    const response = await POST(request(ordinaryForm(operation)));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await response.json()).inputItemIds, [inputItemId]);
    assert.equal(state.authCalls, 1);
    assert.equal(state.reports.length, 0);
    assert.equal(
      state.answers.length + state.bulk.length + state.undo.length,
      1
    );
    if (operation === "answer") {
      const parsed = state.answers[0];
      assert.ok(parsed?.ok);
      assert.equal(parsed.feedback, "Approved after review");
    }
    if (operation === "bulk-answer") {
      const parsed = state.bulk[0];
      assert.ok(parsed?.ok);
      assert.equal(parsed.items[0]?.feedback, "Independent feedback");
    }
  });
}

test("POST preserves origin and authentication gates before consuming a body", async () => {
  for (const operation of ["answer", "bulk-answer", "undo"]) {
    for (const headers of [{ origin: "https://other.test" }, { origin: "" }]) {
      const { POST, state } = routeHarness();
      const req = request(ordinaryForm(operation), headers);
      await assertMutationFailure(
        await POST(req),
        403,
        "invalid_request",
        "Refresh the page and try again."
      );
      assert.equal(req.bodyUsed, false);
      assert.equal(state.authCalls, 0);
      assert.equal(state.reports.length, 0);
    }
    const { POST, state } = routeHarness();
    state.userId = null;
    const req = request(ordinaryForm(operation));
    await assertMutationFailure(
      await POST(req),
      401,
      "authentication_required",
      "Your session expired. Sign in again, then retry the action."
    );
    assert.equal(req.bodyUsed, false);
    assert.equal(state.answers.length, 0);
    assert.equal(state.reports.length, 0);
  }
});

test("POST preserves independent feedback in ordinary multipart bulk answers", async () => {
  const { POST, state } = routeHarness();
  const form = ordinaryForm("bulk-answer");
  const secondId = "00000000-0000-4000-8000-000000000006";
  form.append(
    "bulkItem",
    JSON.stringify({ inputItemId: secondId, callerId, expectedRevision: 4 })
  );
  form.set(`feedback.${secondId}`, "Second item's own feedback");
  const response = await POST(request(form));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).inputItemIds, [
    inputItemId,
    secondId
  ]);
  assert.deepEqual(
    state.stored.map((payload) =>
      payload.ok ? payload.responsePayload : null
    ),
    [
      { feedback: "Independent feedback" },
      { feedback: "Second item's own feedback" }
    ]
  );
});

test("POST preserves forwarded origin and the fixture auth bypass", async () => {
  const { POST, state } = routeHarness();
  state.fixture = true;
  state.userId = null;
  assert.equal(
    (
      await POST(
        request(ordinaryForm("undo"), {
          origin: "https://public.test",
          "x-forwarded-host": "public.test, proxy.test",
          "x-forwarded-proto": "https, http"
        })
      )
    ).status,
    200
  );
  assert.equal(state.authCalls, 0);
  assert.equal(state.undo.length, 1);
});

test("POST preserves action-service conflict, validation, and availability statuses", async () => {
  for (const [code, status] of [
    ["revision_conflict", 409],
    ["invalid_request", 400],
    ["temporary_unavailable", 503],
    ["missing_configuration", 503]
  ]) {
    const { POST, state } = routeHarness();
    state.failureCode = String(code);
    const response = await POST(request(ordinaryForm("answer")));
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.equal(state.reports.length, 0);
  }
});

test(
  "POST accepts 100 distinct URL-encoded answers with meaningful maximum Unicode feedback",
  { timeout: 15_000 },
  async () => {
    const { POST, state } = routeHarness();
    const params = new URLSearchParams();
    for (const [key, value] of ordinaryForm("bulk-answer")) {
      if (key !== "bulkItem" && !key.startsWith("feedback."))
        params.append(key, String(value));
    }
    const feedback = "漢".repeat(42_661);
    assert.equal(Buffer.byteLength(JSON.stringify({ feedback })), 127_998);
    for (let i = 1; i <= 100; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      params.append(
        "bulkItem",
        JSON.stringify({
          inputItemId: id,
          callerId,
          expectedRevision: Number.MAX_SAFE_INTEGER
        })
      );
      params.set(`feedback.${id}`, feedback);
    }
    const encoded = params.toString();
    assert.ok(
      Buffer.byteLength(encoded) > 34 * 1024 * 1024,
      "accepted shape exceeds the old cap"
    );
    const response = await POST(
      request(encoded, { "content-type": "application/x-www-form-urlencoded" })
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answered, 100);
    assert.equal(state.stored.length, 100);
    for (const payload of state.stored) {
      assert.ok(payload.ok);
      assert.equal(payload.responsePayloadBytes, 127_998);
      assert.deepEqual(payload.responsePayload, { feedback });
    }
    assert.equal(state.reports.length, 0);
  }
);

test(
  "POST accepts a maximum raw file with semantically maximum feedback and UI metadata",
  { timeout: 15_000 },
  async () => {
    const { POST, state } = routeHarness();
    const form = ordinaryForm("answer");
    form.set("popupKind", "file_upload");
    form.set(
      "feedback",
      "x".repeat(SYSTEM_CONTRACT.humanAnswerResponseBodyBytes - 15)
    );
    form.set(
      "response.file",
      new File(
        [new Uint8Array(SYSTEM_CONTRACT.rawFileBytes)],
        "evidence 漢.bin",
        { type: "application/octet-stream" }
      )
    );
    const response = await POST(request(form));
    assert.equal(response.status, 200);
    const parsed = state.answers[0];
    assert.ok(parsed?.ok);
    assert.equal(parsed.response.kind, "file_upload");
    assert.ok(parsed.response.kind === "file_upload");
    assert.equal(parsed.response.file.size, SYSTEM_CONTRACT.rawFileBytes);
    assert.equal(parsed.response.file.name, "evidence 漢.bin");
    const payload = state.stored[0];
    assert.ok(payload?.ok);
    assert.equal(payload.responsePayloadBytes, 128_000);
    assert.equal(state.reports.length, 0);
  }
);

test("POST rejects known native malformed bodies and invalid operations without reporting", async () => {
  for (const contentType of [
    null,
    "text/plain",
    "multipart/form-data",
    "multipart/form-data; boundary=x"
  ]) {
    const { POST, state } = routeHarness();
    const req = request(
      new Uint8Array(Buffer.from("not a form")),
      contentType ? { "content-type": contentType } : {}
    );
    if (contentType === null)
      assert.equal(req.headers.get("content-type"), null);
    const response = await POST(req);
    assert.equal(response.status, 400, String(contentType));
    assert.equal((await response.json()).code, "invalid_request");
    assert.equal(state.reports.length, 0);
    assert.equal(state.answers.length, 0);
  }
  const { POST, state } = routeHarness();
  const form = ordinaryForm("answer");
  form.set("_operation", "unknown");
  await assertMutationFailure(
    await POST(request(form)),
    400,
    "invalid_request",
    "Action failed: invalid request."
  );
  assert.equal(state.reports.length, 0);
  assert.equal(state.answers.length, 0);
});

test("POST rejects an unknown popupKind without storing an answer", async () => {
  const { POST, state } = routeHarness();
  const form = ordinaryForm("answer");
  form.set("popupKind", "unknown");
  await assertMutationFailure(
    await POST(request(form)),
    400,
    "invalid_request",
    "Invalid action"
  );
  assert.deepEqual(state.answers, [{ ok: false }]);
  assert.equal(state.stored.length, 0);
  assert.equal(state.reports.length, 0);
});

test(
  "POST rejects declared and finite streamed overflow, including understated length",
  { timeout: 15_000 },
  async () => {
    const declared = routeHarness();
    const req = request(ordinaryForm("answer"), {
      "content-length": String(
        requestBody.HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT + 1
      )
    });
    const response = await declared.POST(req);
    assert.equal(response.status, 413);
    assert.equal(req.bodyUsed, false);
    assert.equal((await response.json()).code, "request_too_large");
    for (const length of [null, "1", "invalid"]) {
      const { POST, state } = routeHarness();
      let chunks = 0;
      let canceled = false;
      const stream = new ReadableStream({
        pull(controller) {
          if (chunks++ < 48) controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.close();
        },
        cancel() {
          canceled = true;
        }
      });
      const res = await POST(
        request(stream, {
          "content-type": "multipart/form-data; boundary=x",
          ...(length ? { "content-length": length } : {})
        })
      );
      assert.equal(res.status, 413);
      assert.equal((await res.json()).code, "request_too_large");
      assert.equal(canceled, true);
      assert.ok(chunks < 48);
      assert.equal(state.answers.length, 0);
      assert.equal(state.reports.length, 0);
    }
  }
);

test("POST reports unknown source errors even when they resemble known parser errors", async () => {
  for (const failure of [
    new Error("client disconnected"),
    new TypeError("Failed to parse body as FormData.")
  ]) {
    const { POST, state } = routeHarness();
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(failure);
      }
    });
    const response = await POST(
      request(stream, { "content-type": "multipart/form-data; boundary=x" })
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "temporary_unavailable");
    assert.equal(state.reports.length, 1);
    assert.equal(state.reports[0]?.error, failure);
    assert.equal(state.reports[0]?.metadata.status_code, 503);
    assert.equal(state.answers.length, 0);
  }
});

test("POST reports unknown parser errors, including TypeErrors", async (t) => {
  for (const failure of [
    new Error("parser runtime failure"),
    new TypeError("Body is unusable: Body has already been read")
  ]) {
    const parser = t.mock.method(Response.prototype, "formData", async () => {
      throw failure;
    });
    try {
      const { POST, state } = routeHarness();
      const response = await POST(request(ordinaryForm("answer")));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "temporary_unavailable");
      assert.equal(state.reports.length, 1);
      assert.equal(state.reports[0]?.error, failure);
      assert.equal(state.answers.length, 0);
    } finally {
      parser.mock.restore();
    }
  }
});

// Replay signatures directly observed by root's native workerd probe. This tests
// the application's mapping contract; it is not a native workerd route probe.
test("POST maps observed workerd client-malformed signatures to 400 without reporting", async (t) => {
  const observedMessages = [
    "Parsing a Body as FormData requires a Content-Type header.",
    "Unrecognized Content-Type header value. FormData can only parse the following MIME types: multipart/form-data, application/x-www-form-urlencoded",
    "No boundary string in Content-Type header. The multipart/form-data MIME type requires a boundary parameter, e.g. 'Content-Type: multipart/form-data; boundary=\"abcd\"'. See RFC 7578, section 4.",
    "No initial boundary string (or you have a truncated message).",
    "No subsequent boundary string after multipart message."
  ];
  for (const message of observedMessages) {
    const parser = t.mock.method(Response.prototype, "formData", async () => {
      throw new TypeError(message);
    });
    try {
      const { POST, state } = routeHarness();
      const response = await POST(request(ordinaryForm("answer")));
      assert.equal(response.status, 400, message);
      assert.equal((await response.json()).code, "invalid_request");
      assert.equal(state.reports.length, 0);
      assert.equal(state.answers.length, 0);
    } finally {
      parser.mock.restore();
    }
  }
});
