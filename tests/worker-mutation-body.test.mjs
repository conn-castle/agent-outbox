import assert from "node:assert/strict";
import test from "node:test";

import * as requestBody from "../src/server/request-body.ts";
import { humanMutationTransportFailureResponse } from "../src/server/human-mutation-response.ts";
import * as hyperdrive from "../worker/hyperdrive.mjs";
import {
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../src/server/human-action-form.ts";
import { validatedResponsePayload } from "../src/server/human-answer.ts";
import { loadModuleForTest } from "./helpers/transpiled-module.mjs";

const origin = "https://agent-outbox.test";
const id = "00000000-0000-4000-8000-000000000003";
const callerId = "00000000-0000-4000-8000-000000000005";

// Real Worker fetch/scheduled exports, body limiter, transport responses and
// Hyperdrive mapping and Sentry reporting/init/flush/logging. OpenNext, scheduled
// services and the Sentry SDK are doubles; no transport or service is started.
// The consuming adapter deliberately mimics the resolved edge converter's first
// arrayBuffer(), then middleware's request reconstruction and second conversion.
/**
 * @param {{ env?: Record<string, string | undefined>, warmClient?: boolean,
 *   initFailure?: Error, flush?: () => Promise<boolean> }} [options]
 */
function harness(options = {}) {
  const state = {
    requests: /** @type {Request[]} */ ([]),
    environments: /** @type {unknown[]} */ ([]),
    contexts: /** @type {unknown[]} */ ([]),
    body: /** @type {ArrayBuffer | null} */ (null),
    response: new Response("adapter-result", {
      status: 207,
      headers: { "x-adapter": "preserved" }
    }),
    adapterFailure: /** @type {unknown} */ (null),
    completedReads: 0,
    reports:
      /** @type {{ error: unknown, metadata: Record<string, unknown> }[]} */ ([]),
    canaries: /** @type {Record<string, unknown>[]} */ ([]),
    cleanups: /** @type {Record<string, unknown>[]} */ ([]),
    scheduledSentryCalls: 0,
    sdkCalls: /** @type {string[]} */ ([]),
    initOptions:
      /** @type {ReturnType<typeof import("../src/server/sentry.ts").sentryRuntimeInitOptions>[]} */ ([]),
    captured: /** @type {Error[]} */ ([]),
    tags: /** @type {Record<string, string>} */ ({}),
    sentryContexts:
      /** @type {{ name: string, value: Record<string, unknown> }[]} */ ([]),
    fingerprints: /** @type {string[][]} */ ([]),
    logs: /** @type {Record<string, unknown>[]} */ ([])
  };
  const processDouble = {
    env: {
      APP_ENV: "production",
      NODE_ENV: "production",
      SENTRY_DSN: "https://public@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@worker-test",
      ...options.env
    }
  };
  /** @param {string} line */
  const recordLog = (line) => state.logs.push(JSON.parse(line));
  const consoleDouble = {
    error: recordLog,
    warn: recordLog,
    log: recordLog
  };
  let client = options.warmClient ? {} : undefined;
  const sdk = {
    getClient: () => client,
    /** @param {ReturnType<typeof import("../src/server/sentry.ts").sentryRuntimeInitOptions>} input */
    init(input) {
      state.sdkCalls.push("init");
      state.initOptions.push(input);
      if (options.initFailure) throw options.initFailure;
      client = {};
    },
    /** @param {(scope: { setTag: (key: string, value: string) => void, setContext: (name: string, value: Record<string, unknown>) => void, setFingerprint: (values: string[]) => void }) => void} callback */
    withScope(callback) {
      callback({
        setTag: (key, value) => (state.tags[key] = value),
        setContext: (name, value) =>
          state.sentryContexts.push({ name, value: { ...value } }),
        setFingerprint: (values) => state.fingerprints.push([...values])
      });
    },
    /** @param {Error} error */
    captureException(error) {
      state.sdkCalls.push("capture");
      state.captured.push(error);
    },
    /** @param {number} timeoutMs */
    flush(timeoutMs) {
      state.sdkCalls.push(`flush:${timeoutMs}`);
      const result = options.flush ? options.flush() : Promise.resolve(true);
      return result.then((flushed) => {
        state.sdkCalls.push("flushed");
        return flushed;
      });
    }
  };
  // Load actual source with an isolated process/console and only explicit
  // dependencies. Config gating, safe logging and exception sanitizing are real.
  /** @param {string} path @param {Record<string, unknown>} dependencies */
  function loadRuntime(path, dependencies) {
    return loadModuleForTest(path, {
      stubs: dependencies,
      globals: {
        Error,
        AggregateError,
        process: processDouble,
        console: consoleDouble
      }
    });
  }
  const observability = loadRuntime("src/server/observability.ts", {});
  const logging = loadRuntime("src/server/logging.ts", {
    "./observability.ts": observability
  });
  const runtime = /** @type {typeof import("../src/server/sentry.ts")} */ (
    loadRuntime("src/server/sentry.ts", {
      "@sentry/nextjs": sdk,
      "./logging.ts": logging,
      "./observability.ts": observability,
      "./correlation.ts": { createCorrelationId: () => "sentry-test-request" }
    })
  );
  const adapters = {
    /** @param {Request} request @param {unknown} env @param {unknown} context */
    async fetch(request, env, context) {
      state.requests.push(request);
      state.environments.push(env);
      state.contexts.push(context);
      const bytes = await request.arrayBuffer();
      const reconstructed = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : bytes
      });
      state.body = await reconstructed.arrayBuffer();
      state.completedReads++;
      if (state.adapterFailure) throw state.adapterFailure;
      return state.response;
    }
  };
  const durableObjects = {
    BucketCachePurge: class {},
    DOQueueHandler: class {},
    DOShardedTagCache: class {}
  };
  const dependencies = {
    "../.open-next/worker.js": {
      __esModule: true,
      default: adapters,
      ...durableObjects
    },
    "./hyperdrive.mjs": hyperdrive,
    "../src/server/request-body.ts": requestBody,
    "../src/server/human-mutation-response.ts": {
      humanMutationTransportFailureResponse
    },
    "../src/server/correlation.ts": {
      createCorrelationId: () => "worker-test-request"
    },
    "../src/server/scheduled.ts": {
      RUNTIME_CRON_SCHEDULE: "17 * * * *",
      /** @param {Record<string, unknown>} input */
      runScheduledCanary(input) {
        state.canaries.push({ ...input });
      },
      /** @param {Record<string, unknown>} input */
      async runScheduledCleanup(input) {
        state.cleanups.push({ ...input });
      }
    },
    "../src/server/sentry.ts": {
      /** @param {unknown} error @param {Record<string, unknown>} metadata */
      reportFetchRuntimeFailure(error, metadata) {
        // Observe the original input, then execute the real helper. This spy
        // alone is not capture proof; SDK calls and safe logs assert delivery.
        state.reports.push({ error, metadata });
        return runtime.reportFetchRuntimeFailure(
          error,
          /** @type {import("../src/server/sentry.ts").RuntimeFailureReportInput} */ (
            metadata
          )
        );
      },
      /** @param {() => Promise<void>} callback */
      runWithScheduledSentry(callback) {
        state.scheduledSentryCalls++;
        return runtime.runWithScheduledSentry(callback);
      }
    }
  };
  const exports =
    /** @type {{ default: { fetch: (request: Request, env: unknown, context: unknown) => Promise<Response>, scheduled: (controller: { cron: string, scheduledTime: number }, env: unknown, context?: { waitUntil: (promise: Promise<void>) => void }) => Promise<void> } } & typeof durableObjects} */ (
      loadModuleForTest("worker/entry.mjs", {
        stubs: dependencies,
        globals: { Request, Response, URL, Date }
      })
    );
  return { worker: exports.default, state, exports, durableObjects };
}

/** @param {BodyInit | null} body @param {Record<string, string>} [headers] @param {string} [path] @param {string} [method] */
function request(
  body,
  headers = {},
  path = "/human/mutations",
  method = "POST"
) {
  return new Request(
    `${origin}${path}`,
    /** @type {RequestInit} */ (
      /** @type {unknown} */ ({
        method,
        body,
        headers: { origin, ...headers },
        duplex: "half"
      })
    )
  );
}

/** @param {string} operation */
function form(operation) {
  const data = new FormData();
  data.set("_operation", operation);
  data.set("noticeAction", "Approve");
  data.set("noticeSubject", "Contract review");
  data.set("returnToQueue", "1");
  for (const [key, value] of Object.entries({
    search: "contract",
    status: "pending",
    priority: "high",
    type: "task",
    order: "updated_at",
    sort: "updated_at",
    dir: "desc",
    then: "priority",
    then_dir: "asc",
    page: "2"
  }))
    data.set(`view.${key}`, value);
  if (operation === "bulk-answer") {
    data.set("bulkActionValue", "approve");
    data.set(
      "bulkItem",
      JSON.stringify({ inputItemId: id, callerId, expectedRevision: 2 })
    );
    data.set(`feedback.${id}`, "Independent feedback");
  } else {
    data.set("inputItemId", id);
    data.set("callerId", callerId);
    if (operation === "undo")
      data.set("outputResultId", "00000000-0000-4000-8000-000000000004");
    else {
      data.set("expectedRevision", "2");
      data.set("actionValue", "approve");
      data.set("popupKind", "none");
      data.set("feedback", "Reviewed");
    }
  }
  return data;
}

/** @param {ArrayBuffer} bytes @param {Request} req */
function parsedForm(bytes, req) {
  return new Response(bytes, {
    headers: { "content-type": req.headers.get("content-type") ?? "" }
  }).formData();
}

test("Worker rejects oversized declarations before invoking OpenNext or consuming the source", async () => {
  const { worker, state } = harness();
  let pulls = 0;
  const req = request(
    new ReadableStream(
      {
        pull(controller) {
          pulls++;
          controller.close();
        }
      },
      { highWaterMark: 0 }
    ),
    {
      "content-length": String(
        requestBody.HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT + 1
      )
    }
  );
  const response = await worker.fetch(req, {}, {});
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    ok: false,
    operation: "answer",
    code: "request_too_large",
    message: `Action failed: request exceeds the ${requestBody.HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT.toLocaleString("en-US")} byte limit.`,
    inputItemIds: []
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(req.bodyUsed, false);
  assert.equal(pulls, 0);
  assert.equal(state.requests.length, 0);
  assert.equal(state.reports.length, 0);
  assert.deepEqual(state.sdkCalls, []);
});

test(
  "Worker stops finite overflow before the consuming converter completes, including understated lengths",
  { timeout: 15_000 },
  async () => {
    for (const declared of [undefined, "1", "invalid"]) {
      const { worker, state } = harness();
      let pulls = 0;
      let canceled = false;
      let cancelReason = /** @type {unknown} */ (undefined);
      const stream = new ReadableStream(
        {
          pull(controller) {
            if (pulls++ < 48) controller.enqueue(new Uint8Array(1024 * 1024));
            else controller.close();
          },
          cancel(reason) {
            canceled = true;
            cancelReason = reason;
          }
        },
        { highWaterMark: 0 }
      );
      const response = await worker.fetch(
        request(stream, {
          "content-type": "multipart/form-data; boundary=x",
          ...(declared === undefined ? {} : { "content-length": declared })
        }),
        {},
        {}
      );
      assert.equal(response.status, 413);
      assert.equal((await response.json()).code, "request_too_large");
      assert.equal(canceled, true);
      assert.ok(cancelReason instanceof requestBody.RequestBodyTooLargeError);
      assert.ok(pulls < 48);
      assert.equal(state.requests.length, 1);
      assert.equal(state.completedReads, 0);
      assert.equal(state.reports.length, 0);
      assert.deepEqual(state.sdkCalls, []);
    }
  }
);

test("Worker forwards ordinary answer, bulk and undo with metadata and environment intact", async () => {
  for (const operation of ["answer", "bulk-answer", "undo"]) {
    const { worker, state } = harness();
    const req = request(form(operation), {
      authorization: "test-auth-context",
      "x-forwarded-host": "public.test"
    });
    const context = { waitUntil() {} };
    const env = {
      AGENT_OUTBOX_DATABASE: {
        connectionString: "postgres://fixture.invalid/db"
      },
      OTHER: "retained"
    };
    const response = await worker.fetch(req, env, context);
    assert.equal(response, state.response);
    assert.equal(state.completedReads, 1);
    const forwarded = state.requests[0];
    assert.ok(forwarded);
    assert.notEqual(forwarded, req);
    assert.equal(forwarded.url, req.url);
    assert.equal(forwarded.method, req.method);
    assert.deepEqual([...forwarded.headers], [...req.headers]);
    assert.equal(state.contexts[0], context);
    assert.deepEqual(state.environments[0], {
      ...env,
      DATABASE_APP_ROLE_URL: "postgres://fixture.invalid/db"
    });
    assert.ok(state.body);
    const nativeForm = await parsedForm(state.body, req);
    const parsed =
      operation === "bulk-answer"
        ? parseBulkHumanAnswersForm(nativeForm)
        : operation === "undo"
          ? parseUndoHumanAnswerForm(nativeForm)
          : parseHumanAnswerForm(nativeForm);
    assert.ok(parsed.ok);
    assert.equal(nativeForm.get("view.search"), "contract");
    assert.equal(nativeForm.get("_operation"), operation);
    assert.equal(state.reports.length, 0);
  }
});

test(
  "Worker forwards meaningful 100-item encoded feedback above 34 MiB intact",
  { timeout: 15_000 },
  async () => {
    const { worker, state } = harness();
    const params = new URLSearchParams();
    for (const [key, value] of form("bulk-answer"))
      if (key !== "bulkItem" && !key.startsWith("feedback."))
        params.append(key, String(value));
    const feedback = "漢".repeat(42_661);
    for (let i = 1; i <= 100; i++) {
      const inputItemId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      params.append(
        "bulkItem",
        JSON.stringify({
          inputItemId,
          callerId,
          expectedRevision: Number.MAX_SAFE_INTEGER
        })
      );
      params.set(`feedback.${inputItemId}`, feedback);
    }
    const encoded = params.toString();
    assert.ok(encoded.length > 34 * 1024 * 1024);
    const req = request(encoded, {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(encoded.length)
    });
    assert.equal(await worker.fetch(req, {}, {}), state.response);
    assert.ok(state.body);
    assert.equal(Buffer.from(state.body).toString(), encoded);
    const parsed = parseBulkHumanAnswersForm(await parsedForm(state.body, req));
    assert.ok(parsed.ok);
    assert.equal(parsed.items.length, 100);
    for (const item of parsed.items) {
      const payload = validatedResponsePayload(
        { popupKind: "none", popupPayload: {} },
        { kind: "none" },
        item.feedback
      );
      assert.ok(payload.ok);
      assert.equal(payload.responsePayloadBytes, 127_998);
      assert.deepEqual(payload.responsePayload, { feedback });
    }
    assert.equal(state.reports.length, 0);
  }
);

test(
  "Worker forwards a maximum file and semantically maximum feedback intact",
  { timeout: 15_000 },
  async () => {
    const { worker, state } = harness();
    const data = form("answer");
    data.set("popupKind", "file_upload");
    data.set("feedback", "x".repeat(127_985));
    data.set(
      "response.file",
      new File([new Uint8Array(32_000_000)], "evidence 漢.bin", {
        type: "application/octet-stream"
      })
    );
    const req = request(data);
    assert.equal(await worker.fetch(req, {}, {}), state.response);
    assert.ok(state.body);
    const parsed = parseHumanAnswerForm(await parsedForm(state.body, req));
    assert.ok(parsed.ok);
    assert.ok(parsed.response.kind === "file_upload");
    assert.equal(parsed.response.file.size, 32_000_000);
    assert.equal(parsed.response.file.name, "evidence 漢.bin");
    assert.equal(parsed.response.file.type, "application/octet-stream");
    const payload = validatedResponsePayload(
      {
        popupKind: "file_upload",
        popupPayload: { label: "Attach", accept_mime_types: null }
      },
      parsed.response,
      parsed.feedback
    );
    assert.ok(payload.ok);
    assert.equal(payload.responsePayloadBytes, 128_000);
    assert.equal(state.reports.length, 0);
  }
);

test("Worker leaves in-budget malformed forms and origin/auth context to the route", async () => {
  const headerCases = /** @type {Record<string, string>[]} */ ([
    { origin: "https://other.test" },
    { origin: "" },
    {}
  ]);
  for (const headers of headerCases) {
    const { worker, state } = harness();
    const req = request(new Uint8Array(Buffer.from("not a form")), headers);
    assert.equal(await worker.fetch(req, {}, {}), state.response);
    assert.ok(state.body);
    assert.equal(Buffer.from(state.body).toString(), "not a form");
    assert.deepEqual([...state.requests[0].headers], [...req.headers]);
    assert.equal(state.reports.length, 0);
  }
});

test("Worker passes unrelated paths and methods through by identity without a new cap", async () => {
  for (const [path, method] of [
    ["/api/input", "POST"],
    ["/human/mutations/other", "POST"],
    ["/human/mutations", "PUT"],
    ["/human/mutations", "GET"]
  ]) {
    const { worker, state } = harness();
    const req = request(
      method === "GET" ? null : "ordinary body",
      {
        "content-length": String(
          requestBody.HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT + 1
        )
      },
      path,
      method
    );
    assert.equal(await worker.fetch(req, {}, {}), state.response);
    assert.equal(state.requests[0], req);
    assert.equal(state.completedReads, 1);
    assert.equal(state.reports.length, 0);
  }
});

test("Worker reports unknown adapter and original source failures instead of misclassifying them", async () => {
  for (const failure of [
    new Error("adapter failure contains private diagnostic"),
    new TypeError(
      "No initial boundary string (or you have a truncated message)."
    ),
    new requestBody.RequestBodyTooLargeError()
  ]) {
    const { worker, state } = harness();
    state.adapterFailure = failure;
    const response = await worker.fetch(request("valid small body"), {}, {});
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "temporary_unavailable");
    assert.equal(state.reports.length, 1);
    assert.equal(state.reports[0]?.error, failure);
    assert.equal(state.reports[0]?.metadata.route, "/human/mutations");
    assert.equal(state.reports[0]?.metadata.status_code, 503);
    assert.equal(
      JSON.stringify(state.reports[0]?.metadata).includes("private diagnostic"),
      false
    );
  }
  const { worker, state } = harness();
  const failure = new TypeError(
    "No initial boundary string (or you have a truncated message)."
  );
  const stream = new ReadableStream({
    pull(controller) {
      controller.error(failure);
    }
  });
  const response = await worker.fetch(
    request(stream, { "content-type": "multipart/form-data; boundary=x" }),
    {},
    {}
  );
  assert.equal(response.status, 503);
  assert.equal(state.completedReads, 0);
  assert.equal(state.reports[0]?.error, failure);
  assert.equal(state.reports.length, 1);
});

test("Worker scheduled behavior and durable-object exports remain unchanged", async () => {
  const { worker, state, exports, durableObjects } = harness();
  assert.equal(exports.BucketCachePurge, durableObjects.BucketCachePurge);
  assert.equal(exports.DOQueueHandler, durableObjects.DOQueueHandler);
  assert.equal(exports.DOShardedTagCache, durableObjects.DOShardedTagCache);
  const pending = /** @type {Promise<void>[]} */ ([]);
  const timestamp = Date.parse("2026-10-05T00:00:00Z");
  await worker.scheduled(
    { cron: "17 * * * *", scheduledTime: timestamp },
    { DATABASE_APP_ROLE_URL: "postgres://fixture.invalid/db" },
    {
      waitUntil(promise) {
        pending.push(promise);
      }
    }
  );
  assert.equal(pending.length, 1);
  await pending[0];
  assert.deepEqual(state.canaries[0], {
    trigger: "cron",
    cron: "17 * * * *",
    scheduledTime: timestamp
  });
  assert.deepEqual(state.cleanups[0], {
    connectionString: "postgres://fixture.invalid/db",
    now: new Date(timestamp)
  });
  await worker.scheduled({ cron: "", scheduledTime: Number.NaN }, {});
  assert.equal(state.canaries[1]?.cron, "17 * * * *");
  assert.deepEqual(state.cleanups[1], {
    connectionString: undefined,
    now: undefined
  });
  assert.equal(state.scheduledSentryCalls, 2);
  assert.equal(state.requests.length, 0);
  assert.equal(state.reports.length, 0);
});

test("Worker protects mutation path aliases recognized by Next without rewriting them", async () => {
  for (const path of ["/human/mutations/", "/human/%6dutati%6fns"]) {
    const { worker, state } = harness();
    const req = request(
      "small body",
      {
        "content-length": String(
          requestBody.HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT + 1
        )
      },
      path
    );
    const response = await worker.fetch(req, {}, {});
    assert.equal(response.status, 413);
    assert.equal(req.bodyUsed, false);
    assert.equal(state.requests.length, 0);
  }
});

test(
  "Worker propagates source and cancellation failures even if their class resembles the cap",
  { timeout: 5_000 },
  async () => {
    for (const failure of [
      new requestBody.RequestBodyTooLargeError(),
      new Error("source failure")
    ]) {
      const { worker, state } = harness();
      const stream = new ReadableStream({
        pull(controller) {
          controller.error(failure);
        }
      });
      assert.equal((await worker.fetch(request(stream), {}, {})).status, 503);
      assert.equal(state.reports[0]?.error, failure);
      assert.equal(state.reports.length, 1);
    }
    const { worker, state } = harness();
    const failure = new Error("unexpected cancellation failure");
    const stream = new ReadableStream(
      {
        pull(controller) {
          controller.enqueue(
            new Uint8Array(
              requestBody.HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT + 1
            )
          );
        },
        cancel() {
          throw failure;
        }
      },
      { highWaterMark: 0 }
    );
    const response = await worker.fetch(request(stream), {}, {});
    assert.equal(response.status, 503);
    assert.equal(state.reports[0]?.error, failure);
    assert.equal(state.reports.length, 1);
  }
);

test("Worker unexpected fetch failures initialize fresh Sentry and sanitize capture before flushing", async () => {
  const { worker, state } = harness();
  const failure = new TypeError("PRIVATE-DIAGNOSTIC token=PRIVATE-TOKEN");
  failure.cause = new Error("PRIVATE-CAUSE");
  state.adapterFailure = failure;
  const response = await worker.fetch(
    request(
      "PRIVATE-BODY",
      {
        authorization: "PRIVATE-AUTHORIZATION",
        cookie: "PRIVATE-COOKIE"
      },
      "/human/mutations?secret=PRIVATE-QUERY"
    ),
    {},
    {}
  );
  assert.equal(response.status, 503);
  assert.deepEqual(
    await response.json(),
    await humanMutationTransportFailureResponse("temporary_unavailable").json()
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(state.sdkCalls, [
    "init",
    "capture",
    "flush:2000",
    "flushed"
  ]);
  assert.equal(state.reports[0]?.error, failure);
  assert.equal(state.initOptions[0]?.release, "agent-outbox@worker-test");
  assert.equal(state.initOptions[0]?.environment, "production");
  assert.equal(
    state.initOptions[0]?.dsn,
    "https://public@o0.ingest.sentry.io/0"
  );
  assert.equal(state.initOptions[0]?.tracesSampleRate, 0.05);
  assert.equal(state.initOptions[0]?.maxBreadcrumbs, 0);
  assert.equal(typeof state.initOptions[0]?.beforeSend, "function");
  assert.equal(typeof state.initOptions[0]?.beforeSendTransaction, "function");
  assert.equal(
    state.initOptions[0]?.integrations[0]?.name,
    "AgentOutboxRuntimeContentSafety"
  );
  assert.equal(state.captured.length, 1);
  assert.notEqual(state.captured[0], failure);
  assert.equal(state.captured[0]?.name, "TypeError");
  assert.equal(state.captured[0]?.message, "Agent Outbox runtime failure");
  assert.equal(state.captured[0]?.cause, undefined);
  assert.equal(state.tags.error_id, "worker-test-request");
  assert.equal(state.tags.route, "/human/mutations");
  assert.equal(state.tags.operation, "human_mutation");
  assert.equal(state.sentryContexts[0]?.name, "agent_outbox");
  assert.equal(state.sentryContexts[0]?.value.error_id, "worker-test-request");
  assert.deepEqual(state.fingerprints, [
    [
      "agent-outbox-runtime-failure",
      "TypeError",
      "human_mutation",
      "/human/mutations"
    ]
  ]);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0]?.sentry_captured, true);
  assert.equal(state.logs[0]?.error_id, "worker-test-request");
  assert.equal(state.logs[0]?.status_code, 503);
  const observed = JSON.stringify({
    logs: state.logs,
    tags: state.tags,
    contexts: state.sentryContexts,
    fingerprints: state.fingerprints,
    captured: state.captured.map((error) => ({
      name: error.name,
      message: error.message,
      stack: error.stack
    }))
  });
  assert.equal(observed.includes("PRIVATE-"), false);
});

test("Worker warm-client source failures still capture and flush without reinitializing", async () => {
  const { worker, state } = harness({ warmClient: true });
  const failure = new RangeError("PRIVATE-SOURCE-DETAIL");
  const response = await worker.fetch(
    request(
      new ReadableStream({
        pull(controller) {
          controller.error(failure);
        }
      })
    ),
    {},
    {}
  );
  assert.equal(response.status, 503);
  assert.equal(state.completedReads, 0);
  assert.equal(state.reports[0]?.error, failure);
  assert.deepEqual(state.sdkCalls, ["capture", "flush:2000", "flushed"]);
  assert.equal(state.captured[0]?.name, "RangeError");
  assert.equal(state.logs[0]?.sentry_captured, true);
});

test(
  "Worker waitUntil keeps the bounded flush alive after returning the original 503",
  { timeout: 5_000 },
  async () => {
    const gate = /** @type {PromiseWithResolvers<boolean>} */ (
      Promise.withResolvers()
    );
    const { worker, state } = harness({ flush: () => gate.promise });
    state.adapterFailure = new Error("PRIVATE-ADAPTER-DETAIL");
    const pending = /** @type {Promise<void>[]} */ ([]);
    const response = await worker.fetch(
      request("small body"),
      {},
      {
        waitUntil(/** @type {Promise<void>} */ task) {
          pending.push(task);
        }
      }
    );
    assert.equal(response.status, 503);
    assert.equal(pending.length, 1);
    assert.deepEqual(state.sdkCalls, ["init", "capture", "flush:2000"]);
    let completed = false;
    const completion = pending[0].then(() => {
      completed = true;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    gate.resolve(true);
    await completion;
    assert.equal(completed, true);
    assert.deepEqual(state.sdkCalls, [
      "init",
      "capture",
      "flush:2000",
      "flushed"
    ]);
  }
);

test(
  "Worker awaits flush in the foreground when waitUntil is unavailable",
  { timeout: 5_000 },
  async () => {
    for (const context of [undefined, {}, { waitUntil: null }]) {
      const gate = /** @type {PromiseWithResolvers<boolean>} */ (
        Promise.withResolvers()
      );
      const started = /** @type {PromiseWithResolvers<void>} */ (
        Promise.withResolvers()
      );
      const { worker, state } = harness({
        flush: () => {
          started.resolve();
          return gate.promise;
        }
      });
      state.adapterFailure = new Error("adapter failed");
      let settled = false;
      const result = worker
        .fetch(request("small body"), {}, context)
        .then((response) => {
          settled = true;
          return response;
        });
      await started.promise;
      assert.equal(settled, false);
      assert.deepEqual(state.sdkCalls, ["init", "capture", "flush:2000"]);
      gate.resolve(true);
      assert.equal((await result).status, 503);
      assert.equal(settled, true);
      assert.equal(state.sdkCalls.at(-1), "flushed");
    }
  }
);

test("Worker capture respects production, release, DSN, CI and test gating even with a warm client", async () => {
  const disabled = /** @type {Record<string, string | undefined>[]} */ ([
    { APP_ENV: "development" },
    { SENTRY_DSN: undefined },
    { SENTRY_RELEASE: undefined },
    { SENTRY_RELEASE: "PRIVATE-INVALID-RELEASE?token" },
    { CI: "true" },
    { NODE_ENV: "test" }
  ]);
  for (const env of disabled) {
    for (const warmClient of [false, true]) {
      const { worker, state } = harness({ env, warmClient });
      state.adapterFailure = new Error("PRIVATE-FAILURE");
      assert.equal(
        (await worker.fetch(request("small body"), {}, {})).status,
        503
      );
      assert.deepEqual(state.sdkCalls, []);
      assert.equal(state.logs.length, 1);
      assert.equal(state.logs[0]?.sentry_captured, false);
      assert.equal(state.logs[0]?.operation, "human_mutation");
      assert.equal(JSON.stringify(state.logs).includes("PRIVATE-"), false);
    }
  }
});

test("Worker Sentry initialization failure stays observable and preserves the original failure and 503", async () => {
  const { worker, state } = harness({
    initFailure: new Error("PRIVATE-INIT-DETAIL")
  });
  state.adapterFailure = new RangeError("PRIVATE-ORIGINAL-DETAIL");
  const response = await worker.fetch(request("small body"), {}, {});
  assert.equal(response.status, 503);
  assert.deepEqual(
    await response.json(),
    await humanMutationTransportFailureResponse("temporary_unavailable").json()
  );
  assert.deepEqual(state.sdkCalls, ["init"]);
  assert.equal(state.logs.length, 2);
  assert.equal(state.logs[0]?.level, "error");
  assert.equal(state.logs[0]?.operation, "runtime.fetch.sentry_init");
  assert.equal(state.logs[1]?.level, "error");
  assert.equal(state.logs[1]?.operation, "human_mutation");
  assert.equal(state.logs[1]?.error_name, "RangeError");
  assert.equal(state.logs[1]?.sentry_captured, false);
  assert.equal(JSON.stringify(state.logs).includes("PRIVATE-"), false);
});

test("Worker timed-out, rejected and synchronously throwing Sentry flushes preserve the captured failure and 503", async () => {
  const flushes = [
    () => Promise.resolve(false),
    () => Promise.reject(new Error("PRIVATE-FLUSH-REJECTION")),
    () => {
      throw new Error("PRIVATE-FLUSH-THROW");
    }
  ];
  for (const flush of flushes) {
    // Exercise both the foreground fallback and waitUntil lifetime path.
    for (const background of [false, true]) {
      const { worker, state } = harness({ flush });
      state.adapterFailure = new Error("PRIVATE-ORIGINAL-DETAIL");
      const pending = /** @type {Promise<void>[]} */ ([]);
      const context = background
        ? {
            waitUntil(/** @type {Promise<void>} */ task) {
              pending.push(task);
            }
          }
        : {};
      const response = await worker.fetch(request("small body"), {}, context);
      await Promise.all(pending);
      assert.equal(response.status, 503);
      assert.deepEqual(
        await response.json(),
        await humanMutationTransportFailureResponse(
          "temporary_unavailable"
        ).json()
      );
      assert.equal(state.captured.length, 1);
      assert.equal(state.logs.length, 2);
      assert.equal(state.logs[0]?.operation, "human_mutation");
      assert.equal(state.logs[0]?.sentry_captured, true);
      assert.equal(state.logs[1]?.level, "warn");
      assert.equal(state.logs[1]?.operation, "runtime.fetch.sentry_flush");
      assert.equal(JSON.stringify(state.logs).includes("PRIVATE-"), false);
    }
  }
});

test("Worker known 400 and declared 413 outcomes do not start standalone Sentry", async () => {
  const { worker, state } = harness();
  state.response = new Response(JSON.stringify({ code: "invalid_request" }), {
    status: 400
  });
  assert.equal(
    (await worker.fetch(request("malformed form"), {}, {})).status,
    400
  );
  assert.equal(
    (
      await worker.fetch(
        request("oversize declaration", {
          "content-length": String(
            requestBody.HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT + 1
          )
        }),
        {},
        {}
      )
    ).status,
    413
  );
  assert.deepEqual(state.sdkCalls, []);
  assert.deepEqual(state.logs, []);
  assert.deepEqual(state.reports, []);
});
