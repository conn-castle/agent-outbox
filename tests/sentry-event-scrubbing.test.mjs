import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

import * as correlation from "../src/server/correlation.ts";
import * as logging from "../src/server/logging.ts";
import * as observability from "../src/server/observability.ts";
import * as requestErrors from "../src/server/request-error-observability.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";

const require = createRequire(import.meta.url);
globalThis.AsyncLocalStorage = AsyncLocalStorage;
/** @type {typeof import("@sentry/nextjs")} */
const Sentry = require("../node_modules/@sentry/nextjs/build/cjs/edge/index.js");
/** @typedef {Parameters<NonNullable<ReturnType<NonNullable<ReturnType<typeof Sentry.getClient>>["getTransport"]>>["send"]>[0]} Envelope */
const runtime = loadModule("../src/server/sentry.ts", {
  "@sentry/nextjs": Sentry,
  "./logging.ts": logging,
  "./correlation.ts": correlation,
  "./observability.ts": observability
});
const { onRequestError } = loadModule("../instrumentation.ts", {
  "@sentry/nextjs": Sentry,
  "./src/server/correlation": correlation,
  "./src/server/logging": logging,
  "./src/server/request-error-observability": requestErrors,
  "./src/server/sentry": runtime
});
const DSN = "https://public@o0.ingest.sentry.io/0";
const RELEASE = "agent-outbox@scrubbing-test";
const MESSAGE = "Agent Outbox runtime failure";
const sensitiveAttributes = Object.fromEntries(
  [
    "http.request.header.authorization",
    "http.request.header.cookie",
    "http.request.header.referer",
    "http.request.header.next-url",
    "http.response.header.set-cookie",
    "http.request.body.data",
    "url.full",
    "url.path",
    "url.query",
    "url.fragment",
    "http.url",
    "http.target",
    "http.query",
    "http.fragment",
    "url"
  ].map((key) => [
    key,
    key === "url.full" || key === "http.target"
      ? `https://example.test/PRIVATE-ATTRIBUTE-${key}?PRIVATE-ROOT-QUERY#PRIVATE-ROOT-FRAGMENT`
      : `PRIVATE-ATTRIBUTE-${key}`
  ])
);
/** @type {Record<string, string | number>} */
const attributes = {
  ...sensitiveAttributes,
  "http.route": "/human",
  "http.request.method": "GET",
  "http.response.status_code": 200,
  "server.address": "127.0.0.1"
};

test("runtime Sentry hooks scrub real edge SDK envelopes", async (t) => {
  await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: DSN,
      SENTRY_RELEASE: RELEASE,
      NODE_ENV: "production",
      CI: undefined
    },
    async () => {
      /** @type {Envelope[]} */
      const envelopes = [];
      /** @type {import("@sentry/nextjs").Event[]} */
      const beforeScrub = [];
      /** @type {string[]} */
      const beforeSamplingTransactions = [];
      const options = runtime.sentryRuntimeInitOptions();
      Sentry.init({
        ...options,
        tracesSampleRate: 1,
        transport: () => ({
          /** @param {Envelope} envelope */
          send: async (envelope) => {
            envelopes.push(structuredClone(envelope));
            return {};
          },
          flush: async () => true
        })
      });
      const client = Sentry.getClient();
      assert.ok(client);
      // Inject odd fields after SDK normalization so they reach the runtime hook.
      client.on("postprocessEvent", (event) => {
        if (!event) {
          return;
        }
        if (event.tags?.case === "odd-fields") {
          Object.assign(event, {
            exception: {
              values: [
                null,
                "odd",
                {
                  type: "Error",
                  value: "PRIVATE-ODD-EXCEPTION",
                  stacktrace: {
                    frames: [
                      null,
                      "odd",
                      { vars: { detail: "PRIVATE-ODD-VARS" } }
                    ]
                  }
                }
              ]
            },
            request: { method: 42 },
            contexts: { nextjs: "odd", trace: { data: "odd" } },
            spans: [null, "odd", { data: null, description: 42 }],
            transaction: 42,
            sdkProcessingMetadata: {
              dynamicSamplingContext: { transaction: 42 }
            }
          });
        }
        if (event.tags?.case === "odd-containers") {
          Object.assign(event, {
            exception: { values: "odd" },
            contexts: { nextjs: null, trace: { data: 42 } },
            spans: {},
            request: null
          });
        }
        const { sdkProcessingMetadata, ...payload } = event;
        beforeScrub.push(structuredClone(payload));
        const samplingTransaction =
          sdkProcessingMetadata?.dynamicSamplingContext?.transaction;
        if (typeof samplingTransaction === "string") {
          beforeSamplingTransactions.push(samplingTransaction);
        }
      });
      const server = http.createServer((_request, response) =>
        response.end("ok")
      );
      try {
        await new Promise((resolve) =>
          server.listen(0, "127.0.0.1", () => resolve(undefined))
        );
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const headers = {
          authorization: "Bearer PRIVATE-AUTHORIZATION",
          cookie: "foo=PRIVATE-COOKIE",
          referer: "https://example.test/?PRIVATE-REFERER",
          "next-url": "/human?PRIVATE-NEXT-URL"
        };
        await Sentry.withIsolationScope(async (scope) => {
          scope.setSDKProcessingMetadata({
            normalizedRequest: { method: "GET", headers }
          });
          scope.addBreadcrumb({ message: "PRIVATE-DIRECT-BREADCRUMB" });
          await Sentry.startSpan(
            {
              name: "GET /human?PRIVATE-TRANSACTION#PRIVATE-TRANSACTION-FRAGMENT",
              op: "http.server",
              attributes
            },
            async () => {
              console.error("PRIVATE-CONSOLE");
              const response = await fetch(
                `http://127.0.0.1:${address.port}/fetch?PRIVATE-FETCH`
              );
              await response.text();
              await Sentry.startSpan(
                {
                  name: "child#PRIVATE-SPAN-FRAGMENT?PRIVATE-SPAN-QUERY",
                  op: "test.child",
                  attributes
                },
                () => {}
              );
              Sentry.captureRequestError(
                new Error("PRIVATE-ERROR-MESSAGE"),
                { path: "/human?PRIVATE-REQUEST-PATH", method: "GET", headers },
                {
                  routerKind: "App Router",
                  routePath: "/human",
                  routeType: "render"
                }
              );
            }
          );
        });
        Sentry.captureRequestError(
          {
            message: "PRIVATE-OBJECT-MESSAGE",
            authorization: "PRIVATE-OBJECT-AUTH"
          },
          { path: "/human", method: "POST", headers: {} },
          { routerKind: "App Router", routePath: "/human", routeType: "render" }
        );
        onRequestError(
          new TypeError("PRIVATE-INSTRUMENTATION-MESSAGE"),
          {
            path: "/human?PRIVATE-INSTRUMENTATION-PATH",
            method: "POST",
            headers
          },
          { routerKind: "App Router", routePath: "/human", routeType: "render" }
        );
        runtime.captureRuntimeException(
          new TypeError("PRIVATE-RUNTIME-MESSAGE"),
          {
            errorId: "err_runtime_test",
            operation: "runtime.test",
            route: "/human"
          }
        );
        const explicitId = Sentry.captureEvent({
          message: "PRIVATE-EVENT-MESSAGE",
          logentry: { message: "PRIVATE-LOGENTRY" },
          extra: { detail: "PRIVATE-EXTRA" },
          request: {
            url: "https://example.test/PRIVATE-URL",
            headers,
            cookies: { foo: "PRIVATE-EVENT-COOKIE" },
            query_string: "PRIVATE-QUERY-STRING",
            data: "PRIVATE-BODY",
            env: { detail: "PRIVATE-ENV" }
          },
          transaction: "event#PRIVATE-EVENT-TRANSACTION",
          contexts: {
            trace: {
              trace_id: "1".repeat(32),
              span_id: "2".repeat(16),
              data: attributes
            }
          },
          exception: {
            values: [
              {
                type: "RangeError",
                value: "PRIVATE-EXPLICIT-EXCEPTION",
                mechanism: { type: "test", handled: true },
                stacktrace: {
                  frames: [
                    {
                      filename: "app.ts",
                      function: "handler",
                      lineno: 42,
                      vars: { detail: "PRIVATE-FRAME-VARS" }
                    }
                  ]
                }
              }
            ]
          }
        });
        const minimalId = Sentry.captureEvent({ tags: { case: "minimal" } });
        Sentry.captureMessage("PRIVATE-CAPTURE-MESSAGE");
        const oddId = Sentry.captureEvent({ tags: { case: "odd-fields" } });
        const oddContainersId = Sentry.captureEvent({
          tags: { case: "odd-containers" }
        });
        await Sentry.startSpan(
          {
            name: "GET /human/[id]",
            op: "http.server",
            attributes: { "sentry.source": "route" }
          },
          () => {}
        );
        assert.equal(await Sentry.flush(2000), true);
        const events = envelopes.flatMap((envelope) =>
          envelope[1]
            .filter(
              ([header]) =>
                header.type === "event" || header.type === "transaction"
            )
            .map(
              ([, event]) =>
                /** @type {import("@sentry/nextjs").Event} */ (event)
            )
        );
        const requestError = events.find(
          (event) =>
            event.exception?.values?.[0]?.mechanism?.type ===
              "auto.function.nextjs.on_request_error" &&
            event.request?.method === "GET"
        );
        // The unscrubbed name keeps its query, so the lookup also finds the
        // transaction when the hooks are disabled and the sentinel checks fail.
        const transaction =
          events.find(
            (event) =>
              event.type === "transaction" &&
              event.contexts?.trace?.op === "http.server" &&
              event.transaction?.startsWith("GET /human?")
          ) ??
          events.find(
            (event) =>
              event.type === "transaction" && event.transaction === "GET /human"
          );
        const explicit = events.find((event) => event.event_id === explicitId);
        assert.ok(requestError);
        assert.ok(transaction);
        assert.ok(explicit);
        const originalTransaction = beforeScrub.find(
          (event) =>
            event.type === "transaction" &&
            event.transaction?.startsWith("GET /human?")
        );
        assert.equal(
          originalTransaction?.contexts?.trace?.data?.["url.full"],
          attributes["url.full"]
        );
        assert.equal(
          originalTransaction?.spans?.find((span) => span.op === "test.child")
            ?.data?.["http.target"],
          attributes["http.target"]
        );
        assert.ok(events.some((event) => event.event_id === minimalId));
        assert.ok(events.some((event) => event.event_id === oddId));
        assert.ok(events.some((event) => event.event_id === oddContainersId));
        const original = JSON.stringify(beforeScrub);
        const serialized = JSON.stringify(envelopes);
        const samplingHeaders = envelopes.map(
          ([header]) =>
            /** @type {Record<string, unknown> | undefined} */ (header.trace)
        );
        const sentinelGroups = {
          "exception messages": [
            "PRIVATE-ERROR-MESSAGE",
            "PRIVATE-EXPLICIT-EXCEPTION"
          ],
          "request paths and headers": [
            "PRIVATE-REQUEST-PATH",
            "PRIVATE-AUTHORIZATION",
            "PRIVATE-COOKIE",
            "PRIVATE-REFERER",
            "PRIVATE-NEXT-URL"
          ],
          // Console breadcrumbs never form (maxBreadcrumbs: 0); the complete
          // envelope check below covers PRIVATE-CONSOLE.
          "fetch and direct scope breadcrumbs": [
            "PRIVATE-FETCH",
            "PRIVATE-DIRECT-BREADCRUMB"
          ],
          "span attributes": Object.values(sensitiveAttributes),
          "transaction and span names including sampling headers": [
            "PRIVATE-TRANSACTION",
            "PRIVATE-TRANSACTION-FRAGMENT",
            "PRIVATE-SPAN-FRAGMENT",
            "PRIVATE-SPAN-QUERY",
            "PRIVATE-EVENT-TRANSACTION"
          ],
          "messages, log entries, extras, request bodies, and frame vars": [
            "PRIVATE-CAPTURE-MESSAGE",
            "PRIVATE-EVENT-MESSAGE",
            "PRIVATE-LOGENTRY",
            "PRIVATE-EXTRA",
            "PRIVATE-URL",
            "PRIVATE-EVENT-COOKIE",
            "PRIVATE-QUERY-STRING",
            "PRIVATE-BODY",
            "PRIVATE-ENV",
            "PRIVATE-FRAME-VARS"
          ],
          "non-Error object serialization": [
            "PRIVATE-OBJECT-MESSAGE",
            "PRIVATE-OBJECT-AUTH"
          ],
          "onRequestError end to end": [
            "PRIVATE-INSTRUMENTATION-MESSAGE",
            "PRIVATE-INSTRUMENTATION-PATH"
          ],
          "odd fields": ["PRIVATE-ODD-EXCEPTION", "PRIVATE-ODD-VARS"]
        };
        for (const [name, sentinels] of Object.entries(sentinelGroups)) {
          await t.test(name, async (group) => {
            for (const sentinel of sentinels) {
              await group.test(sentinel, () => {
                assert.ok(
                  original.includes(sentinel),
                  `harness must exercise ${sentinel}`
                );
                assert.equal(
                  serialized.includes(sentinel),
                  false,
                  `envelopes must exclude ${sentinel}`
                );
              });
            }
          });
        }
        await t.test("complete envelopes contain no private sentinels", () => {
          assert.doesNotMatch(serialized, /PRIVATE-/);
        });
        for (const sentinel of [
          "PRIVATE-TRANSACTION",
          "PRIVATE-TRANSACTION-FRAGMENT"
        ]) {
          await t.test(`sampling envelope headers exclude ${sentinel}`, () => {
            assert.ok(
              beforeSamplingTransactions.some((name) => name.includes(sentinel))
            );
            assert.equal(
              JSON.stringify(samplingHeaders).includes(sentinel),
              false
            );
          });
        }
        await t.test("diagnostic fields survive scrubbing", () => {
          assert.equal(options.dsn, DSN);
          assert.equal(options.environment, "production");
          assert.equal(options.release, RELEASE);
          assert.equal(options.tracesSampleRate, 0.05);
          const exception = requestError.exception?.values?.[0];
          assert.equal(exception?.type, "Error");
          assert.equal(exception?.value, MESSAGE);
          assert.equal(exception?.mechanism?.handled, false);
          assert.ok(exception?.stacktrace?.frames?.length);
          assert.deepEqual(requestError.request, { method: "GET" });
          assert.deepEqual(requestError.contexts?.nextjs, {
            router_path: "/human",
            router_kind: "App Router",
            route_type: "render"
          });
          assert.ok(transaction.contexts?.trace?.trace_id);
          assert.ok(transaction.contexts?.trace?.span_id);
          assert.equal(transaction.contexts?.trace?.op, "http.server");
          for (const data of [
            transaction.contexts?.trace?.data,
            transaction.spans?.find((span) => span.op === "test.child")?.data
          ]) {
            assert.ok(data);
            assert.equal(data["http.route"], "/human");
            assert.equal(data["http.request.method"], "GET");
            assert.equal(data["http.response.status_code"], 200);
            assert.equal(data["server.address"], "127.0.0.1");
          }
          const frame =
            explicit.exception?.values?.[0]?.stacktrace?.frames?.[0];
          assert.equal(frame?.filename, "app.ts");
          assert.equal(frame?.function, "handler");
          assert.equal(frame?.lineno, 42);
          assert.equal(explicit.exception?.values?.[0]?.type, "RangeError");
          assert.equal(
            explicit.exception?.values?.[0]?.mechanism?.type,
            "test"
          );
          assert.equal("request" in explicit, false);
          const routeTransaction = events.find(
            (event) =>
              event.type === "transaction" &&
              event.transaction === "GET /human/[id]"
          );
          assert.equal(routeTransaction?.transaction_info?.source, "route");
          const samplingHeader = samplingHeaders.find(
            (header) => header?.transaction === "GET /human"
          );
          assert.equal(samplingHeader?.release, RELEASE);
          assert.equal(samplingHeader?.environment, "production");
          assert.ok(samplingHeader?.trace_id);
          const instrumented = events.find(
            (event) => event.tags?.operation === "next_request_error"
          );
          assert.match(String(instrumented?.tags?.error_id), /^err_/);
          assert.equal(
            instrumented?.contexts?.agent_outbox?.error_id,
            instrumented?.tags?.error_id
          );
          assert.equal(
            instrumented?.contexts?.agent_outbox?.operation,
            "next_request_error"
          );
          const runtimeEvent = events.find(
            (event) => event.tags?.error_id === "err_runtime_test"
          );
          assert.deepEqual(runtimeEvent?.fingerprint, [
            "agent-outbox-runtime-failure",
            "TypeError",
            "runtime.test",
            "/human"
          ]);
          assert.equal(
            runtimeEvent?.contexts?.agent_outbox?.error_id,
            "err_runtime_test"
          );
        });
      } finally {
        await Sentry.close(2000);
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve(undefined)))
        );
      }
    }
  );
});

/**
 * @param {string} path
 * @param {Record<string, unknown>} modules
 * @returns {Record<string, Function>}
 */
function loadModule(path, modules) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: path
  }).outputText;
  const testModule = { exports: {} };
  vm.runInNewContext(
    compiled,
    {
      console,
      exports: testModule.exports,
      module: testModule,
      process,
      /** @param {string} specifier */
      require(specifier) {
        if (specifier in modules) {
          return modules[specifier];
        }
        throw new Error(`Unexpected test import: ${specifier}`);
      }
    },
    { filename: path }
  );
  return testModule.exports;
}
