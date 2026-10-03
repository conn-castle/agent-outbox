import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

import {
  emitRuntimeLog,
  safeErrorCode,
  safeErrorName
} from "../src/server/logging.ts";
import { runtimeRelease } from "../src/server/observability.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The Worker build aliases @sentry/nextjs to this edge entry (next.config.ts).
const Sentry = require(
  resolve(
    dirname(require.resolve("@sentry/nextjs/package.json")),
    "build/cjs/edge/index.js"
  )
);
const { reportRuntimeFailure, sentryRuntimeInitOptions } = loadSentryModule();

const PRODUCTION_ENV = {
  APP_ENV: "production",
  SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
  SENTRY_RELEASE: "agent-outbox@2026.10.03",
  CI: undefined,
  NODE_ENV: "production"
};
const SECRETS = [
  "sk_live_caller_key",
  "eyJhbGciOiJSUzI1NiJ9.session.sig",
  "user@example.com",
  "SECRET",
  "out_caller_specific",
  "file_caller_specific",
  "raw console text"
];

/** @type {Array<Record<string, any>>} */
const sent = [];

/** Compiles src/server/sentry.ts against the edge SDK the Worker runs. */
function loadSentryModule() {
  const source = readFileSync(
    resolve(REPO_ROOT, "src/server/sentry.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "src/server/sentry.ts"
  }).outputText;
  const testModule = { exports: /** @type {Record<string, any>} */ ({}) };

  vm.runInNewContext(
    compiled,
    {
      Error,
      exports: testModule.exports,
      module: testModule,
      process,
      /** @param {string} specifier */
      require(specifier) {
        const modules = {
          "@sentry/nextjs": Sentry,
          "./logging.ts": { emitRuntimeLog, safeErrorCode, safeErrorName },
          "./observability.ts": { runtimeRelease }
        };
        if (!(specifier in modules)) {
          throw new Error(`Unexpected import ${specifier}`);
        }
        return modules[/** @type {keyof typeof modules} */ (specifier)];
      }
    },
    { filename: "src/server/sentry.ts" }
  );

  return testModule.exports;
}

before(() => {
  withProcessEnv(PRODUCTION_ENV, () => {
    Sentry.init({
      ...sentryRuntimeInitOptions(),
      // Sampling is not under test; trace every span so transactions are sent.
      tracesSampleRate: 1,
      transport: () => ({
        /** @param {any} envelope */
        send: async (envelope) => {
          for (const [header, payload] of envelope[1]) {
            if (header.type === "event" || header.type === "transaction") {
              sent.push(payload);
            }
          }
          return {};
        },
        flush: async () => true
      })
    });
  });
});

beforeEach(() => {
  sent.length = 0;
  for (const scope of [Sentry.getIsolationScope(), Sentry.getCurrentScope()]) {
    scope.clear();
    // Scope.clear() does not clear SDK request metadata.
    scope.setSDKProcessingMetadata({ normalizedRequest: null });
  }
});

after(async () => {
  await Sentry.close();
});

/** @param {Record<string, any>} event */
function assertNoSecrets(event) {
  const serialized = JSON.stringify(event);
  for (const secret of SECRETS) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
}

test("request errors keep route templates without caller paths, headers, cookies, queries, or raw messages", async () => {
  console.error("raw console text");
  Sentry.addBreadcrumb({
    category: "fetch",
    type: "http",
    data: {
      method: "GET",
      url: "https://api.example.test/users?email=user@example.com#SECRET",
      "http.query": "email=user@example.com",
      "http.fragment": "SECRET",
      "url.fragment": "SECRET"
    }
  });
  Sentry.withScope((/** @type {any} */ scope) => {
    scope.setTag("error_id", "err_scrub_test");
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        url: "https://app.example.test/api/output/out_caller_specific/files/file_caller_specific?code=SECRET"
      }
    });
    Sentry.captureRequestError(
      new Error('invalid input syntax for uuid: "user@example.com"', {
        cause: new Error("code=SECRET")
      }),
      {
        path: "/api/output/out_caller_specific/files/file_caller_specific?email=user@example.com&code=SECRET",
        method: "POST",
        headers: {
          authorization: "Bearer sk_live_caller_key",
          cookie: "__session=eyJhbGciOiJSUzI1NiJ9.session.sig",
          "user-agent": "test"
        }
      },
      {
        routerKind: "App Router",
        routePath: "/api/output/[output_result_id]/files/[file_id]",
        routeType: "route"
      }
    );
  });
  await Sentry.flush(2000);

  assert.equal(sent.length, 1);
  const [event] = sent;
  assertNoSecrets(event);
  assert.equal(event.message, undefined);
  assert.equal(event.tags.error_id, "err_scrub_test");
  assert.deepEqual(event.contexts.nextjs, {
    router_path: "/api/output/[output_result_id]/files/[file_id]",
    router_kind: "App Router",
    route_type: "route"
  });
  assert.equal(Object.hasOwn(event.request, "url"), false);
  assert.equal(event.request.method, "POST");
  assert.ok(event.exception.values.length >= 2);
  for (const exception of event.exception.values) {
    assert.equal(exception.type, "Error");
    assert.equal(exception.value, "Agent Outbox runtime failure");
    assert.ok(exception.stacktrace.frames.length > 0);
  }
  assert.deepEqual(
    event.breadcrumbs.find(
      (/** @type {any} */ breadcrumb) => breadcrumb.category === "fetch"
    ).data,
    { method: "GET", url: "https://api.example.test/users" }
  );
});

test("message captures reach Sentry with a fixed top-level message", async () => {
  Sentry.captureMessage("user@example.com used Bearer sk_live_caller_key");
  await Sentry.flush(2000);

  assert.equal(sent.length, 1);
  assertNoSecrets(sent[0]);
  assert.equal(sent[0].message, "Agent Outbox runtime failure");
});

for (const type of [undefined, "transaction"]) {
  test(`${type ?? "error"} events scrub messages and omit request URLs when no route template is available`, async () => {
    Sentry.captureEvent({
      ...(type === "transaction"
        ? {
            type: /** @type {const} */ ("transaction"),
            transaction: "safe operation",
            start_timestamp: Date.now() / 1000 - 1,
            timestamp: Date.now() / 1000,
            spans: [
              {
                trace_id: "0123456789abcdef0123456789abcdef",
                span_id: "0123456789abcdef",
                start_timestamp: Date.now() / 1000 - 1,
                timestamp: Date.now() / 1000,
                op: "http.client",
                data: {
                  "url.fragment": "SECRET",
                  "url.full": "https://api.example.test/users#SECRET"
                }
              }
            ]
          }
        : {}),
      message: "user@example.com requested /api/output/out_caller_specific",
      request: {
        method: "GET",
        url: "https://app.example.test/api/output/out_caller_specific/files/file_caller_specific?code=SECRET#SECRET"
      }
    });
    await Sentry.flush(2000);

    assert.equal(sent.length, 1);
    const [event] = sent;
    assertNoSecrets(event);
    assert.equal(event.message, "Agent Outbox runtime failure");
    assert.deepEqual(event.request, { method: "GET" });
    assert.equal(event.contexts?.nextjs?.router_path, undefined);
    if (type === "transaction") {
      assert.equal(event.spans.length, 1);
      assert.equal(Object.hasOwn(event.spans[0].data, "url.fragment"), false);
      assert.equal(
        event.spans[0].data["url.full"],
        "https://api.example.test/users"
      );
    }
  });
}

test("thrown non-Error values reach Sentry without their serialized fields", async () => {
  Sentry.captureRequestError(
    { code: "P0001", detail: "user@example.com owns key sk_live_caller_key" },
    { path: "/api/v1/items", method: "POST", headers: {} },
    { routerKind: "App Router", routePath: "/api/v1/items", routeType: "route" }
  );
  await Sentry.flush(2000);

  assert.equal(sent.length, 1);
  assertNoSecrets(sent[0]);
});

test("runtime failure reports keep their safe tags after scrubbing", async () => {
  await withProcessEnv(PRODUCTION_ENV, async () => {
    const result = reportRuntimeFailure(new TypeError("user@example.com"), {
      errorId: "err_runtime_scrub",
      surface: "api",
      route: "/api/v1/items",
      operation: "scrub_test",
      message: "Runtime failure"
    });
    assert.equal(result.sentry_captured, true);
    await Sentry.flush(2000);
  });

  assert.equal(sent.length, 1);
  const [event] = sent;
  assertNoSecrets(event);
  assert.equal(event.message, undefined);
  assert.equal(event.tags.error_id, "err_runtime_scrub");
  assert.equal(event.tags.operation, "scrub_test");
  assert.equal(event.contexts.agent_outbox.error_id, "err_runtime_scrub");
  assert.deepEqual(event.fingerprint, [
    "agent-outbox-runtime-failure",
    "TypeError",
    "scrub_test",
    "/api/v1/items"
  ]);
  assert.equal(event.exception.values[0].type, "TypeError");
  assert.equal(event.exception.values[0].value, "Agent Outbox runtime failure");
  assert.ok(event.exception.values[0].stacktrace.frames.length > 0);
});

test("transactions reach Sentry without span URL queries or fragments", async () => {
  Sentry.startSpan(
    {
      name: "GET https://api.example.test/users",
      attributes: {
        "url.full": "https://api.example.test/users?email=user@example.com",
        "http.target": "/users?email=user@example.com#SECRET",
        "http.query": "email=user@example.com",
        "http.fragment": "SECRET",
        "url.query": "?email=user@example.com",
        "url.fragment": "SECRET"
      }
    },
    () => {}
  );
  await Sentry.flush(2000);

  assert.equal(sent.length, 1);
  const [transaction] = sent;
  assert.equal(transaction.type, "transaction");
  assertNoSecrets(transaction);
  assert.equal(
    transaction.contexts.trace.data["url.full"],
    "https://api.example.test/users"
  );
  assert.equal(transaction.contexts.trace.data["http.target"], "/users");
  assert.equal(
    Object.hasOwn(transaction.contexts.trace.data, "url.fragment"),
    false
  );
});

test("middleware transactions reach Sentry without request header attributes", async () => {
  const middleware = Sentry.wrapMiddlewareWithSentry(
    async () => new Response(null, { status: 204 })
  );
  await middleware(
    new Request("https://app.example.test/human", {
      headers: {
        authorization: "Bearer sk_live_caller_key",
        cookie: "__session=eyJhbGciOiJSUzI1NiJ9.session.sig; theme=SECRET",
        referer: "https://app.example.test/prev?invite=SECRET",
        "x-custom": "user@example.com"
      }
    })
  );
  await Sentry.flush(2000);

  const transaction = sent.find((event) => event.type === "transaction");
  assert.ok(transaction);
  assertNoSecrets(transaction);
  assert.deepEqual(
    Object.keys(transaction.contexts.trace.data).filter((key) =>
      key.startsWith("http.request.header.")
    ),
    []
  );
});
