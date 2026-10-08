import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadModuleForTest } from "./helpers/transpiled-module.mjs";
import { tsImport } from "tsx/esm/api";

import * as apiRoute from "../src/server/api-route.ts";
import { INPUT_REQUEST_BODY_BYTE_LIMIT } from "../src/server/request-body.ts";

const inputRead = await tsImport(
  "../app/api/input/read/route.ts",
  import.meta.url
);
const outputCheck = await tsImport(
  "../app/api/output/check/route.ts",
  import.meta.url
);

test("input read rejects malformed JSON with the error envelope and request ID", async () => {
  const response = await inputRead.POST(
    new Request("https://example.com/api/input/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": "invalid_json_route_test"
      },
      body: "{"
    })
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("X-Request-ID"), "invalid_json_route_test");
  assert.equal(response.headers.get("Cache-Control"), null);
  const payload = await response.json();
  assert.equal(typeof payload.correlation_id, "string");
  assert.ok(payload.correlation_id.length > 0);
  assert.equal(
    response.headers.get("X-Correlation-ID"),
    payload.correlation_id
  );
  assert.deepEqual(payload, {
    ok: false,
    request_id: "invalid_json_route_test",
    correlation_id: payload.correlation_id,
    error: {
      code: "invalid_json",
      message: "Request body must be valid JSON."
    }
  });
});

test("input read rejects a streamed JSON body above the byte limit", async () => {
  const response = await inputRead.POST(
    new Request("https://example.com/api/input/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": "oversized_route_test"
      },
      body: JSON.stringify("x".repeat(INPUT_REQUEST_BODY_BYTE_LIMIT))
    })
  );

  assert.equal(response.status, 413);
  assert.equal(response.headers.get("X-Request-ID"), "oversized_route_test");
  assert.equal(response.headers.get("Cache-Control"), null);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.request_id, "oversized_route_test");
  assert.equal(payload.error.code, "request_too_large");
  assert.equal(
    payload.error.limit.limit_name,
    "input_request_body_bytes_excluding_files"
  );
});

test("output check cursor validation errors do not carry no-store", async () => {
  const response = await outputCheck.GET(
    new Request("https://example.com/api/output/check?cursor=invalid", {
      headers: { "X-Request-ID": "invalid_cursor_route_test" }
    })
  );

  assert.equal(response.status, 422);
  assert.equal(response.headers.get("Cache-Control"), null);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.request_id, "invalid_cursor_route_test");
  assert.equal(payload.error.code, "validation_failed");
  assert.deepEqual(payload.error.fields, [
    {
      path: "cursor",
      code: "invalid_cursor",
      message: "cursor is invalid or expired."
    }
  ]);
});

const root = fileURLToPath(new URL("../", import.meta.url));
/** @type {[string, string, string, string, boolean][]} */
const routeCases = [
  [
    "POST",
    "/api/caller/connect/abort",
    "caller-connect",
    "handleConnectAbortRequest",
    false
  ],
  [
    "POST",
    "/api/caller/connect/activate",
    "caller-connect",
    "handleConnectActivateRequest",
    false
  ],
  [
    "POST",
    "/api/caller/connect/exchange",
    "caller-connect",
    "handleConnectExchangeRequest",
    false
  ],
  [
    "POST",
    "/api/caller/connect/browser/start",
    "caller-connect",
    "handleConnectBrowserStartRequest",
    false
  ],
  [
    "POST",
    "/api/caller/connect/device/start",
    "caller-connect",
    "handleConnectDeviceStartRequest",
    false
  ],
  [
    "POST",
    "/api/caller/connect/device/poll",
    "caller-connect",
    "handleConnectDevicePollRequest",
    false
  ],
  [
    "POST",
    "/api/caller/rotate/abort",
    "caller-credential-operations",
    "handleRotateAbortRequest",
    false
  ],
  [
    "POST",
    "/api/caller/rotate/activate",
    "caller-credential-operations",
    "handleRotateActivateRequest",
    false
  ],
  [
    "POST",
    "/api/caller/rotate/exchange",
    "caller-credential-operations",
    "handleRotateExchangeRequest",
    false
  ],
  [
    "POST",
    "/api/caller/rotate/browser/start",
    "caller-credential-operations",
    "handleRotateBrowserStartRequest",
    false
  ],
  [
    "POST",
    "/api/caller/rotate/device/start",
    "caller-credential-operations",
    "handleRotateDeviceStartRequest",
    false
  ],
  [
    "POST",
    "/api/caller/rotate/device/poll",
    "caller-credential-operations",
    "handleRotateDevicePollRequest",
    false
  ],
  [
    "POST",
    "/api/caller/revoke/confirm",
    "caller-credential-operations",
    "handleRevokeConfirmRequest",
    false
  ],
  [
    "POST",
    "/api/caller/revoke/browser/start",
    "caller-credential-operations",
    "handleRevokeBrowserStartRequest",
    false
  ],
  [
    "POST",
    "/api/caller/revoke/device/start",
    "caller-credential-operations",
    "handleRevokeDeviceStartRequest",
    false
  ],
  [
    "POST",
    "/api/caller/revoke/device/poll",
    "caller-credential-operations",
    "handleRevokeDevicePollRequest",
    false
  ],
  ["POST", "/api/input/send", "input-queue", "handleInputQueueRequest", false],
  [
    "POST",
    "/api/input/replace",
    "input-queue",
    "handleInputQueueRequest",
    false
  ],
  [
    "POST",
    "/api/input/delete",
    "input-queue",
    "handleInputQueueRequest",
    false
  ],
  ["POST", "/api/input/read", "input-read", "handleInputReadRequest", true],
  [
    "POST",
    "/api/output/read-all",
    "output-queue",
    "handleOutputReadAllRequest",
    true
  ],
  ["GET", "/api/account/status", "status", "handleAccountStatusRequest", false],
  ["GET", "/api/caller/status", "status", "handleCallerStatusRequest", false],
  ["GET", "/api/input/list", "input-read", "handleInputListRequest", true],
  [
    "GET",
    "/api/output/check",
    "output-queue",
    "handleOutputCheckRequest",
    true
  ],
  [
    "POST",
    "/api/output/[output_result_id]/read",
    "output-queue",
    "handleOutputReadRequest",
    true
  ],
  [
    "POST",
    "/api/output/[output_result_id]/ack",
    "output-queue",
    "handleOutputAckRequest",
    true
  ]
];

/**
 * @param {string} route
 * @param {string} handlerModule
 * @param {string} handlerName
 * @param {(...args: any[]) => Promise<any>} handler
 * @returns {Record<string, (request: Request, context?: any) => Promise<Response>>}
 */
function loadRoute(route, handlerModule, handlerName, handler) {
  const filename = resolve(root, `app${route}/route.ts`);
  return /** @type {Record<string, (request: Request, context?: any) => Promise<Response>>} */ (
    loadModuleForTest(`app${route}/route.ts`, {
      /** @param {string} specifier */
      fallbackRequire(specifier) {
        const path = resolve(dirname(filename), specifier);
        if (path === resolve(root, "src/server/api-route")) return apiRoute;
        if (path === resolve(root, `src/server/${handlerModule}`)) {
          return { [handlerName]: handler };
        }
        throw new Error(`Unexpected route dependency: ${specifier}`);
      }
    })
  );
}

/** @param {string} method @param {string} route @param {string} [body] */
function routeRequest(method, route, body = "{}") {
  return new Request(
    `https://example.com${route.replace("[output_result_id]", "output-123")}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": "route_wiring_test"
      },
      ...(method === "POST" && !route.includes("[output_result_id]")
        ? { body }
        : {})
    }
  );
}

for (const [method, route, handlerModule, handlerName, noStore] of routeCases) {
  test(`${method} ${route} preserves success headers, envelope and handler inputs`, async () => {
    const request = routeRequest(method, route);
    /** @type {any[][]} */
    const calls = [];
    const isInputMutation = handlerName === "handleInputQueueRequest";
    const data = { value: "preserved" };
    const exports = loadRoute(
      route,
      handlerModule,
      handlerName,
      async (...args) => {
        calls.push(args);
        return { ok: true, data };
      }
    );
    const response = await exports[method](request, {
      params: Promise.resolve({ output_result_id: "output-123" })
    });
    assert.equal(calls.length, 1);
    const [receivedRequest, context, ...inputs] = calls[0];
    assert.equal(receivedRequest, request);
    assert.equal(context.route, route);
    assert.equal(context.method, method);
    assert.equal(context.requestId, "route_wiring_test");
    assert.equal(typeof context.startedAtMs, "number");
    if (route.includes("[output_result_id]")) {
      assert.deepEqual(inputs, ["output-123"]);
    } else if (isInputMutation) {
      assert.deepEqual(inputs, [route.split("/").at(-1), {}]);
    } else {
      assert.deepEqual(inputs, method === "POST" ? [{}] : []);
    }
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Cache-Control"),
      noStore ? "no-store" : null
    );
    assert.equal(response.headers.get("X-Request-ID"), context.requestId);
    assert.equal(
      response.headers.get("X-Correlation-ID"),
      context.correlationId
    );
    assert.deepEqual(await response.json(), {
      ok: true,
      request_id: context.requestId,
      correlation_id: context.correlationId,
      data: { value: "preserved" }
    });
  });

  test(`${method} ${route} preserves handler errors without no-store`, async () => {
    let calls = 0;
    const exports = loadRoute(route, handlerModule, handlerName, async () => {
      calls++;
      return {
        ok: false,
        error: {
          status: 429,
          code: "rate_limit_exceeded",
          message: "Try later.",
          retryAfterSeconds: 7
        }
      };
    });
    const response = await exports[method](routeRequest(method, route), {
      params: Promise.resolve({ output_result_id: "output-123" })
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Cache-Control"), null);
    assert.equal(response.headers.get("Retry-After"), "7");
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.request_id, "route_wiring_test");
    assert.equal(
      response.headers.get("X-Correlation-ID"),
      payload.correlation_id
    );
    assert.deepEqual(payload.error, {
      code: "rate_limit_exceeded",
      message: "Try later.",
      retry_after_seconds: 7
    });
  });

  if (method === "POST" && !route.includes("[output_result_id]")) {
    test(`${route} body failures stop before the business handler`, async () => {
      let calls = 0;
      const exports = loadRoute(route, handlerModule, handlerName, async () => {
        calls++;
        return { ok: true, data: {} };
      });
      const malformed = await exports.POST(routeRequest(method, route, "{"));
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, "invalid_json");
      const oversized = routeRequest(method, route);
      oversized.headers.set(
        "Content-Length",
        String(INPUT_REQUEST_BODY_BYTE_LIMIT + 1)
      );
      const overflow = await exports.POST(oversized);
      assert.equal(overflow.status, 413);
      assert.equal((await overflow.json()).error.code, "request_too_large");
      assert.equal(malformed.headers.get("Cache-Control"), null);
      assert.equal(overflow.headers.get("Cache-Control"), null);
      assert.equal(calls, 0);
    });
  }
}

for (const route of [
  "/api/input/read",
  "/api/output/[output_result_id]/read"
]) {
  test(`${route} propagates thrown handler errors`, async () => {
    const failure = new Error("handler failure");
    const exports = loadRoute(
      route,
      route.includes("/input/") ? "input-read" : "output-queue",
      route.includes("/input/")
        ? "handleInputReadRequest"
        : "handleOutputReadRequest",
      async () => {
        throw failure;
      }
    );
    await assert.rejects(
      exports.POST(routeRequest("POST", route), {
        params: Promise.resolve({ output_result_id: "output-123" })
      }),
      (error) => error === failure
    );
  });
}

const inputMutationResults = {
  send: {
    caller_item_id: "email:1",
    status: "pending",
    revision: 1,
    created: true,
    duplicate: false
  },
  replace: {
    caller_item_id: "email:1",
    status: "pending",
    revision: 2,
    replaced: true,
    changed: true
  },
  delete: { caller_item_id: "email:1", deleted: true }
};

/**
 * Loads the real input mutation route and input-queue handler; only the
 * authenticated caller transaction is stubbed.
 *
 * @param {string} operation
 * @param {unknown} transactionData
 */
async function loadInputMutationRoute(operation, transactionData) {
  const inputQueue = loadModuleForTest("src/server/input-queue.ts", {
    globals: {
      process: { env: { DATABASE_APP_ROLE_URL: "postgresql://route-test" } }
    },
    stubs: {
      "./accounting.ts": {},
      "./api-errors.ts": await import("../src/server/api-errors.ts"),
      "./caller-api-auth.ts": {
        async runAuthenticatedCallerTransaction() {
          return { authenticated: true, data: transactionData };
        }
      },
      "./caller-api-limits.ts": {},
      "./database.ts": {},
      "./input-schema.ts": await import("../src/server/input-schema.ts"),
      "./logging.ts": await import("../src/server/logging.ts"),
      "./sentry.ts": {}
    }
  });
  return loadRoute(
    `/api/input/${operation}`,
    "input-queue",
    "handleInputQueueRequest",
    /** @type {(...args: any[]) => Promise<any>} */ (
      inputQueue.handleInputQueueRequest
    )
  );
}

for (const [operation, publicData] of Object.entries(inputMutationResults)) {
  test(`POST /api/input/${operation} omits the internal operation from response data`, async () => {
    const exports = await loadInputMutationRoute(operation, {
      ok: true,
      data: { operation, ...publicData }
    });
    const response = await exports.POST(
      routeRequest(
        "POST",
        `/api/input/${operation}`,
        JSON.stringify({ caller_item_id: "email:1" })
      )
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, publicData);
  });

  test(`POST /api/input/${operation} returns transaction errors without data`, async () => {
    const exports = await loadInputMutationRoute(operation, {
      ok: false,
      error: {
        status: 409,
        code: "input_not_pending",
        message:
          "Input replace/delete is allowed only while the item is pending."
      }
    });
    const response = await exports.POST(
      routeRequest(
        "POST",
        `/api/input/${operation}`,
        JSON.stringify({ caller_item_id: "email:1" })
      )
    );
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, "input_not_pending");
    assert.equal("data" in payload, false);
  });
}

test("input read creates the context before consuming the body", async () => {
  const request = routeRequest("POST", "/api/input/read");
  assert.ok(request.body);
  const getReader = request.body.getReader.bind(request.body);
  Object.defineProperty(request.body, "getReader", {
    value() {
      request.headers.set("X-Request-ID", "after_body_read");
      return getReader();
    }
  });
  const exports = loadRoute(
    "/api/input/read",
    "input-read",
    "handleInputReadRequest",
    async (_request, context) => {
      assert.equal(context.requestId, "route_wiring_test");
      return { ok: true, data: {} };
    }
  );
  const response = await exports.POST(request);
  assert.equal(request.headers.get("X-Request-ID"), "after_body_read");
  assert.equal(response.headers.get("X-Request-ID"), "route_wiring_test");
});

for (const action of ["read", "ack"]) {
  test(`output ${action} creates the context before awaiting params`, async () => {
    const route = `/api/output/[output_result_id]/${action}`;
    const request = routeRequest("POST", route);
    const exports = loadRoute(
      route,
      "output-queue",
      action === "read" ? "handleOutputReadRequest" : "handleOutputAckRequest",
      async (_request, context, id) => {
        assert.equal(context.requestId, "route_wiring_test");
        assert.equal(id, "output-123");
        return { ok: true, data: {} };
      }
    );
    const response = await exports.POST(request, {
      params: {
        /** @param {(value: {output_result_id: string}) => void} resolve */
        then(resolve) {
          request.headers.set("X-Request-ID", "after_params");
          resolve({ output_result_id: "output-123" });
        }
      }
    });
    assert.equal(request.headers.get("X-Request-ID"), "after_params");
    assert.equal(response.headers.get("X-Request-ID"), "route_wiring_test");
  });
}

test("billing routes return the 503 envelope when the database URL is missing", async () => {
  const previous = process.env.DATABASE_APP_ROLE_URL;
  delete process.env.DATABASE_APP_ROLE_URL;
  try {
    for (const route of ["checkout", "portal", "webhook"]) {
      const { POST } = await tsImport(
        `../app/api/billing/${route}/route.ts`,
        import.meta.url
      );
      const response = await POST(
        new Request(`https://example.com/api/billing/${route}`, {
          method: "POST",
          headers: { "X-Request-ID": `billing_${route}_route_test` }
        })
      );

      assert.equal(response.status, 503, route);
      assert.equal(
        response.headers.get("X-Request-ID"),
        `billing_${route}_route_test`
      );
      const payload = await response.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.request_id, `billing_${route}_route_test`);
      assert.equal(payload.error.code, "temporary_unavailable");
      assert.match(
        payload.error.message,
        route === "webhook"
          ? /^Billing database configuration is unavailable\.$/
          : /^Billing route configuration is missing required variable names: .*DATABASE_APP_ROLE_URL\.$/
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_APP_ROLE_URL;
    } else {
      process.env.DATABASE_APP_ROLE_URL = previous;
    }
  }
});
