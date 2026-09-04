import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

import { emitRuntimeLog, safeErrorName } from "../src/server/logging.ts";
import {
  NEXT_REQUEST_ERROR_MESSAGE,
  NEXT_REQUEST_ERROR_OPERATION,
  classifyNextRequestError
} from "../src/server/request-error-observability.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_EVIDENCE = [
  "/wp-login.php",
  "/does-not-exist",
  "token=supersecret",
  "----WebKitFormBoundary7MA4YWxkTrZu0gW",
  "----broken",
  "attacker-value",
  "raw-filename.jpg",
  "No initial boundary string",
  "truncated message"
];

test("classifyNextRequestError maps original path shape without returning the path", () => {
  assert.deepEqual(
    classifyNextRequestError(
      { path: "/does-not-exist", method: "POST", headers: {} },
      { routePath: "/_not-found/page" }
    ),
    {
      route: "/_not-found/page",
      method: "POST",
      path_shape: "extensionless",
      multipart_boundary: "not_multipart",
      content_length_state: "absent"
    }
  );
  assert.equal(
    classifyNextRequestError(
      { path: "/wp-login.php", method: "GET", headers: {} },
      { routePath: "/_not-found/page" }
    ).path_shape,
    "contains_dot"
  );
  assert.equal(
    classifyNextRequestError(
      { path: "/foo.bar/baz", method: "GET", headers: {} },
      { routePath: "/_not-found/page" }
    ).path_shape,
    "contains_dot"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist?file=raw-filename.jpg",
        method: "GET",
        headers: {}
      },
      { routePath: "/_not-found/page" }
    ).path_shape,
    "extensionless"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "https://app.agent-outbox.dev/wp-login.php?token=supersecret",
        method: "GET",
        headers: {}
      },
      { routePath: "/_not-found/page" }
    ).path_shape,
    "contains_dot"
  );
  assert.equal(
    classifyNextRequestError(
      { path: "", method: "GET", headers: {} },
      { routePath: "/_not-found/page" }
    ).path_shape,
    "unknown"
  );
  assert.equal(
    classifyNextRequestError(
      { method: "GET", headers: {} },
      { routePath: "/_not-found/page" }
    ).path_shape,
    "unknown"
  );
  assert.equal(
    classifyNextRequestError(
      /** @type {any} */ ({ path: null, method: "GET", headers: {} }),
      { routePath: "/_not-found/page" }
    ).path_shape,
    "unknown"
  );
});

test("classifyNextRequestError classifies multipart boundary parameters without keeping values", () => {
  const route = { routePath: "/_not-found/page" };

  assert.equal(
    classifyNextRequestError(
      { path: "/does-not-exist", method: "POST", headers: {} },
      route
    ).multipart_boundary,
    "not_multipart"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: { "content-type": "application/json" }
      },
      route
    ).multipart_boundary,
    "not_multipart"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: { "Content-Type": "Multipart/Form-Data" }
      },
      route
    ).multipart_boundary,
    "absent"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: { "content-type": "multipart/form-data; charset=utf-8" }
      },
      route
    ).multipart_boundary,
    "absent"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=" }
      },
      route
    ).multipart_boundary,
    "empty"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: { "content-type": 'multipart/form-data; boundary=""' }
      },
      route
    ).multipart_boundary,
    "empty"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type":
            'multipart/form-data; boundary="----WebKitFormBoundary7MA4YWxkTrZu0gW"'
        }
      },
      route
    ).multipart_boundary,
    "quoted"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; BOUNDARY=----broken"
        }
      },
      route
    ).multipart_boundary,
    "unquoted"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type": 'multipart/form-data; boundary="unclosed'
        }
      },
      route
    ).multipart_boundary,
    "malformed"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=foo bar"
        }
      },
      route
    ).multipart_boundary,
    "malformed"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary" }
      },
      route
    ).multipart_boundary,
    "malformed"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=----a; boundary=----b"
        }
      },
      route
    ).multipart_boundary,
    "multiple"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type":
            'multipart/form-data; charset=utf-8; boundary="----broken"'
        }
      },
      route
    ).multipart_boundary,
    "quoted"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type": [
            "multipart/form-data; boundary=----a",
            "multipart/form-data; boundary=----b"
          ]
        }
      },
      route
    ).multipart_boundary,
    "malformed"
  );

  const serialized = JSON.stringify(
    classifyNextRequestError(
      {
        path: "/does-not-exist",
        method: "POST",
        headers: {
          "content-type":
            'multipart/form-data; boundary="----WebKitFormBoundary7MA4YWxkTrZu0gW"'
        }
      },
      route
    )
  );
  assertForbiddenEvidenceAbsent(serialized);
});

test("classifyNextRequestError classifies content length without keeping the raw value", () => {
  const route = { routePath: "/_not-found/page" };

  assert.equal(
    classifyNextRequestError({ path: "/", method: "POST", headers: {} }, route)
      .content_length_state,
    "absent"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/",
        method: "POST",
        headers: { "Content-Length": "0" }
      },
      route
    ).content_length_state,
    "zero"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/",
        method: "POST",
        headers: { "content-length": "512" }
      },
      route
    ).content_length_state,
    "positive"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/",
        method: "POST",
        headers: { "content-length": "-1" }
      },
      route
    ).content_length_state,
    "invalid"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/",
        method: "POST",
        headers: { "content-length": "1.5" }
      },
      route
    ).content_length_state,
    "invalid"
  );
  assert.equal(
    classifyNextRequestError(
      {
        path: "/",
        method: "POST",
        headers: { "content-length": ["12", "13"] }
      },
      route
    ).content_length_state,
    "invalid"
  );

  const serialized = JSON.stringify(
    classifyNextRequestError(
      {
        path: "/",
        method: "POST",
        headers: { "content-length": "512" }
      },
      route
    )
  );
  assert.equal(serialized.includes("512"), false);
});

test("classifyNextRequestError ignores query and unsafe canonical routes", () => {
  assert.equal(
    classifyNextRequestError(
      {
        path: "/does-not-exist?token=supersecret",
        method: "POST",
        headers: {}
      },
      { routePath: "/_not-found/page?token=supersecret" }
    ).route,
    "unknown"
  );
  assert.equal(
    classifyNextRequestError(
      { path: "/does-not-exist", method: "TRACE", headers: {} },
      { routePath: "/_not-found/page" }
    ).method,
    "other"
  );
  assert.equal(
    classifyNextRequestError(
      { path: "/does-not-exist", method: "post", headers: {} },
      { routePath: "/api/runtime/error/route" }
    ).method,
    "POST"
  );
});

test("classifyNextRequestError reports unavailable header metadata as unknown", () => {
  const classification = classifyNextRequestError(
    { path: "/does-not-exist", method: "POST" },
    { routePath: "/_not-found/page" }
  );

  assert.equal(classification.multipart_boundary, "unknown");
  assert.equal(classification.content_length_state, "unknown");
});

test("classifyNextRequestError reports unknown path shape for unclassified or non-string paths and fallbacks", () => {
  assert.equal(
    classifyNextRequestError(
      /** @type {any} */ ({ path: 42, method: "POST" }),
      { routePath: "/_not-found/page" }
    ).path_shape,
    "unknown"
  );
  assert.deepEqual(classifyNextRequestError(null, null), {
    route: "unknown",
    method: "other",
    path_shape: "unknown",
    multipart_boundary: "unknown",
    content_length_state: "unknown"
  });

  const throwingRequest = /** @type {any} */ ({
    get path() {
      throw new Error("unexpected error reading path");
    }
  });
  assert.deepEqual(classifyNextRequestError(throwingRequest, null), {
    route: "unknown",
    method: "other",
    path_shape: "unknown",
    multipart_boundary: "unknown",
    content_length_state: "unknown"
  });
});

test("classifyNextRequestError never reads a request body", () => {
  const request = restrictedRequest({
    path: "/does-not-exist",
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=----broken",
      "content-length": "9"
    }
  });

  assert.deepEqual(
    classifyNextRequestError(request, { routePath: "/_not-found/page" }),
    {
      route: "/_not-found/page",
      method: "POST",
      path_shape: "extensionless",
      multipart_boundary: "unquoted",
      content_length_state: "positive"
    }
  );
});

test("onRequestError captures once, shares error_id, and redacts request evidence", async () => {
  const error = new TypeError(
    "No initial boundary string (or you have a truncated message)."
  );
  const request = restrictedRequest({
    path: "/wp-login.php?token=supersecret",
    method: "POST",
    headers: {
      "content-type":
        'multipart/form-data; boundary="----WebKitFormBoundary7MA4YWxkTrZu0gW"',
      "content-length": "512",
      "x-attacker": "attacker-value"
    }
  });
  const errorContext = {
    routerKind: "App Router",
    routePath: "/_not-found/page",
    routeType: "render"
  };
  /** @type {Array<{ error: unknown, request: unknown, errorContext: unknown }>} */
  const captures = [];
  /** @type {Map<string, unknown>} */
  const tags = new Map();
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const contexts = [];
  const { onRequestError } = loadInstrumentationForTest({
    createCorrelationId: () => "err_next_request_error",
    sentryCaptureEnabled: () => true,
    /**
     * @param {unknown} capturedError
     * @param {unknown} capturedRequest
     * @param {unknown} capturedContext
     */
    captureRequestError(capturedError, capturedRequest, capturedContext) {
      captures.push({
        error: capturedError,
        request: capturedRequest,
        errorContext: capturedContext
      });
    },
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void
     * }) => void} callback
     */
    withScope(callback) {
      callback({
        /**
         * @param {string} name
         * @param {unknown} value
         */
        setTag(name, value) {
          tags.set(name, value);
        },
        /**
         * @param {string} name
         * @param {Record<string, unknown>} value
         */
        setContext(name, value) {
          contexts.push({ name, value });
        }
      });
    }
  });

  const logs = await captureStructuredLogs(() => {
    onRequestError(error, request, errorContext);
  });

  assert.equal(captures.length, 1);
  assert.equal(captures[0].error, error);
  assert.equal(captures[0].request, request);
  assert.equal(captures[0].errorContext, errorContext);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].error_id, "err_next_request_error");
  assert.equal(logs[0].error_name, "TypeError");
  assert.equal(logs[0].sentry_captured, true);
  assert.equal(logs[0].sentry_scope_attached, true);
  assert.equal(logs[0].operation, NEXT_REQUEST_ERROR_OPERATION);
  assert.equal(logs[0].message, NEXT_REQUEST_ERROR_MESSAGE);
  assert.equal(logs[0].route, "/_not-found/page");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].path_shape, "contains_dot");
  assert.equal(logs[0].multipart_boundary, "quoted");
  assert.equal(logs[0].content_length_state, "positive");
  assert.equal(tags.get("error_id"), "err_next_request_error");
  assert.equal(tags.get("operation"), NEXT_REQUEST_ERROR_OPERATION);
  assert.equal(tags.get("route"), "/_not-found/page");
  assert.equal(tags.get("path_shape"), "contains_dot");
  assert.equal(tags.get("multipart_boundary"), "quoted");
  assert.equal(tags.get("content_length_state"), "positive");
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, "agent_outbox");
  assert.equal(contexts[0].value.error_id, "err_next_request_error");
  assert.equal(contexts[0].value.operation, NEXT_REQUEST_ERROR_OPERATION);
  assert.equal(contexts[0].value.route, "/_not-found/page");
  assert.equal("path" in logs[0], false);
  assert.equal("path" in contexts[0].value, false);
  assertForbiddenEvidenceAbsent(JSON.stringify(logs[0]));
  assertForbiddenEvidenceAbsent(JSON.stringify(Object.fromEntries(tags)));
  assertForbiddenEvidenceAbsent(JSON.stringify(contexts));
});

test("onRequestError still captures when scope tagging fails", async () => {
  const error = new TypeError("No initial boundary string");
  const request = {
    path: "/does-not-exist",
    method: "POST",
    headers: { "content-type": "multipart/form-data" }
  };
  const errorContext = {
    routerKind: "App Router",
    routePath: "/_not-found/page",
    routeType: "render"
  };
  /** @type {unknown[]} */
  const captures = [];
  const { onRequestError } = loadInstrumentationForTest({
    createCorrelationId: () => "err_scope_failure",
    sentryCaptureEnabled: () => false,
    /**
     * @param {unknown} capturedError
     */
    captureRequestError(capturedError) {
      captures.push(capturedError);
    },
    withScope() {
      throw new Error("scope unavailable");
    }
  });

  const logs = await withProcessEnv(
    {
      APP_ENV: "test",
      SENTRY_DSN: undefined,
      SENTRY_RELEASE: undefined
    },
    () =>
      captureStructuredLogs(() => {
        onRequestError(error, request, errorContext);
      })
  );

  assert.equal(captures.length, 1);
  assert.equal(captures[0], error);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].error_id, "err_scope_failure");
  assert.equal(logs[0].sentry_captured, false);
  assert.equal(logs[0].sentry_scope_attached, false);
  assert.equal(logs[0].multipart_boundary, "absent");
  assertForbiddenEvidenceAbsent(JSON.stringify(logs[0]));
});

test("onRequestError logs a failed capture without retrying the delegate", async () => {
  let captures = 0;
  const { onRequestError } = loadInstrumentationForTest({
    createCorrelationId: () => "err_capture_failure",
    sentryCaptureEnabled: () => true,
    captureRequestError() {
      captures += 1;
      throw new Error("Sentry transport failed with raw detail");
    },
    withScope() {
      throw new Error("scope unavailable");
    }
  });

  const logs = await captureStructuredLogs(() => {
    onRequestError(
      new TypeError("raw request failure"),
      {
        path: "/private.php?token=supersecret",
        method: "POST",
        headers: undefined
      },
      {
        routerKind: "App Router",
        routePath: "/_not-found/page",
        routeType: "render"
      }
    );
  });

  assert.equal(captures, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].error_id, "err_capture_failure");
  assert.equal(logs[0].sentry_captured, false);
  assert.equal(logs[0].sentry_scope_attached, false);
  assert.equal(logs[0].multipart_boundary, "unknown");
  assert.equal(logs[0].content_length_state, "unknown");
  assert.equal(JSON.stringify(logs[0]).includes("supersecret"), false);
  assert.equal(JSON.stringify(logs[0]).includes("raw request failure"), false);
  assert.equal(JSON.stringify(logs[0]).includes("raw detail"), false);
});

/**
 * @param {object} input
 * @param {string} [input.path]
 * @param {string} [input.method]
 * @param {Record<string, string | string[] | undefined>} [input.headers]
 */
function restrictedRequest(input) {
  return new Proxy(input, {
    get(target, property) {
      if (
        property === "path" ||
        property === "method" ||
        property === "headers"
      ) {
        return target[property];
      }

      throw new Error(`unexpected request field: ${String(property)}`);
    }
  });
}

/**
 * @param {string} serialized
 */
function assertForbiddenEvidenceAbsent(serialized) {
  for (const evidence of FORBIDDEN_EVIDENCE) {
    assert.equal(
      serialized.includes(evidence),
      false,
      `unexpected evidence ${evidence}`
    );
  }
}

/**
 * @param {() => void} callback
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function captureStructuredLogs(callback) {
  const originals = {
    error: console.error,
    log: console.log,
    warn: console.warn
  };
  /** @type {Array<Record<string, unknown>>} */
  const lines = [];

  console.error = (line) => {
    lines.push(JSON.parse(String(line)));
  };
  console.log = (line) => {
    lines.push(JSON.parse(String(line)));
  };
  console.warn = (line) => {
    lines.push(JSON.parse(String(line)));
  };

  try {
    await callback();
  } finally {
    console.error = originals.error;
    console.log = originals.log;
    console.warn = originals.warn;
  }

  return lines;
}

/**
 * @param {{
 *   createCorrelationId: () => string,
 *   sentryCaptureEnabled: () => boolean,
 *   captureRequestError: Function,
 *   withScope: Function
 * }} stubs
 * @returns {{ onRequestError: Function }}
 */
function loadInstrumentationForTest(stubs) {
  const source = readFileSync(resolve(REPO_ROOT, "instrumentation.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "instrumentation.ts"
  }).outputText;
  const testModule = {
    exports: /** @type {Record<string, unknown>} */ ({})
  };

  vm.runInNewContext(
    compiled,
    {
      console,
      exports: testModule.exports,
      module: testModule,
      process,
      /**
       * @param {string} specifier
       */
      require(specifier) {
        if (specifier === "@sentry/nextjs") {
          return {
            withScope: stubs.withScope,
            captureRequestError: stubs.captureRequestError
          };
        }
        if (specifier === "./src/server/correlation") {
          return { createCorrelationId: stubs.createCorrelationId };
        }
        if (specifier === "./src/server/logging") {
          return { emitRuntimeLog, safeErrorName };
        }
        if (specifier === "./src/server/request-error-observability") {
          return {
            NEXT_REQUEST_ERROR_MESSAGE,
            NEXT_REQUEST_ERROR_OPERATION,
            classifyNextRequestError
          };
        }
        if (specifier === "./src/server/sentry") {
          return { sentryCaptureEnabled: stubs.sentryCaptureEnabled };
        }

        return require(specifier);
      }
    },
    { filename: "instrumentation.ts" }
  );

  return /** @type {{ onRequestError: Function }} */ (testModule.exports);
}
