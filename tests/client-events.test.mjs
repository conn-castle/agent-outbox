import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

import {
  classifyReactError,
  clientEventsTestInternals,
  emitClientEvent,
  registerClientEventFlushListeners
} from "../src/client/client-events.ts";
import {
  applyRateLimitRule,
  checkRateLimitRule,
  RATE_LIMIT_RULE_DESCRIPTION
} from "../scripts/cloudflare-ratelimit.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {{ name: string, category?: string }} TestClientEvent
 * @typedef {{ url: string, init: RequestInit & { headers: Record<string, string>, body?: BodyInit | null } }} FetchCall
 * @typedef {{ classifyReactError: (error: unknown) => "hydration" | "other", emitClientEvent: (name: string, category?: string) => void }} ClientEventsStub
 */

test("classifyReactError detects React hydration failures without matching unrelated errors", () => {
  for (const code of ["418", "419", "421", "422", "423", "425"]) {
    assert.equal(
      classifyReactError(new Error(`Minified React error #${code}; see docs`)),
      "hydration"
    );
    assert.equal(
      classifyReactError({
        digest: `https://react.dev/errors?invariant=${code}&args[]=x`
      }),
      "hydration"
    );
  }

  assert.equal(
    classifyReactError(
      new Error(
        "Hydration failed because the server rendered HTML did not match the client."
      )
    ),
    "hydration"
  );
  assert.equal(classifyReactError(new Error("plain render failure")), "other");
  assert.equal(classifyReactError({ digest: "500" }), "other");
});

test("emitClientEvent buffers a burst and drains it across bounded batches", async () => {
  const previousFetch = globalThis.fetch;
  /** @type {FetchCall[]} */
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      init: /** @type {FetchCall["init"]} */ (init ?? {})
    });
    return new Response(null, { status: 204 });
  };

  try {
    clientEventsTestInternals.queue.length = 0;
    for (let index = 0; index < 10; index += 1) {
      emitClientEvent("client_error", "browser_exception");
    }
    // A 10-event burst exceeds the per-flush batch size, so the first flush
    // sends one bounded batch and reschedules for the remainder.
    await clientEventsTestInternals.flushClientEvents();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/client-events");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.keepalive, true);
    assert.equal(requests[0].init.headers["Content-Type"], "application/json");
    const firstBody = JSON.parse(String(requests[0].init.body));
    assert.equal(firstBody.events.length, 8);
    assert.deepEqual(firstBody.events[0], {
      name: "client_error",
      category: "browser_exception"
    });

    // The remaining 2 events are drained by the rescheduled flush, not dropped
    // at the batch boundary.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(requests.length, 2);
    assert.equal(JSON.parse(String(requests[1].init.body)).events.length, 2);
    assert.equal(clientEventsTestInternals.queue.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registerClientEventFlushListeners flushes on pagehide and hidden visibility", async () => {
  const previousFetch = globalThis.fetch;
  /** @type {FetchCall[]} */
  const posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({
      url: String(url),
      init: /** @type {FetchCall["init"]} */ (init ?? {})
    });
    return new Response(null, { status: 204 });
  };

  /** @type {Map<string, (event: Event) => void>} */
  const windowHandlers = new Map();
  /** @type {Map<string, (event: Event) => void>} */
  const documentHandlers = new Map();
  /** @type {string[]} */
  const windowRemoved = [];
  /** @type {string[]} */
  const documentRemoved = [];
  const fakeDocument = {
    visibilityState: "visible",
    /**
     * @param {string} type
     * @param {(event: Event) => void} handler
     */
    addEventListener(type, handler) {
      documentHandlers.set(type, handler);
    },
    /** @param {string} type */
    removeEventListener(type) {
      documentRemoved.push(type);
    }
  };
  const fakeWindow = /** @type {Window} */ (
    /** @type {unknown} */ ({
      document: fakeDocument,
      /**
       * @param {string} type
       * @param {(event: Event) => void} handler
       */
      addEventListener(type, handler) {
        windowHandlers.set(type, handler);
      },
      /** @param {string} type */
      removeEventListener(type) {
        windowRemoved.push(type);
      }
    })
  );

  /** @returns {Promise<void>} */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  try {
    const cleanup = registerClientEventFlushListeners(fakeWindow);

    // pagehide flushes the queued batch.
    clientEventsTestInternals.queue.length = 0;
    emitClientEvent("client_error", "browser_exception");
    windowHandlers.get("pagehide")?.(new Event("pagehide"));
    await tick();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/client-events");
    assert.equal(posts[0].init.method, "POST");

    // visibilitychange while hidden flushes.
    clientEventsTestInternals.queue.length = 0;
    emitClientEvent("client_error", "browser_exception");
    fakeDocument.visibilityState = "hidden";
    documentHandlers.get("visibilitychange")?.(new Event("visibilitychange"));
    await tick();
    assert.equal(posts.length, 2);

    // visibilitychange while visible does not flush.
    clientEventsTestInternals.queue.length = 0;
    emitClientEvent("client_error", "browser_exception");
    fakeDocument.visibilityState = "visible";
    documentHandlers.get("visibilitychange")?.(new Event("visibilitychange"));
    await tick();
    assert.equal(posts.length, 2);

    cleanup();
    assert.ok(windowRemoved.includes("pagehide"));
    assert.ok(documentRemoved.includes("visibilitychange"));
  } finally {
    clientEventsTestInternals.queue.length = 0;
    globalThis.fetch = previousFetch;
  }
});

test("app error boundary emits hydration_error or client_error from classified React errors", () => {
  /** @type {TestClientEvent[]} */
  const emissions = [];
  const ErrorBoundary = loadErrorBoundaryForTest({
    classifyReactError: () => "hydration",
    /**
     * @param {string} name
     * @param {string} [category]
     */
    emitClientEvent: (name, category) => emissions.push({ name, category })
  });
  ErrorBoundary({ error: new Error("fixture"), reset: () => {} });
  assert.deepEqual(emissions, [
    { name: "hydration_error", category: "hydration" }
  ]);

  /** @type {TestClientEvent[]} */
  const otherEmissions = [];
  const OtherBoundary = loadErrorBoundaryForTest({
    classifyReactError: () => "other",
    /**
     * @param {string} name
     * @param {string} [category]
     */
    emitClientEvent: (name, category) => otherEmissions.push({ name, category })
  });
  OtherBoundary({ error: new Error("fixture"), reset: () => {} });
  assert.deepEqual(otherEmissions, [
    { name: "client_error", category: "browser_exception" }
  ]);
});

test("app error boundary drives the real classifyReactError from the thrown error", () => {
  /** @type {TestClientEvent[]} */
  const hydrationEmissions = [];
  const HydrationBoundary = loadErrorBoundaryForTest({
    classifyReactError,
    /**
     * @param {string} name
     * @param {string} [category]
     */
    emitClientEvent: (name, category) =>
      hydrationEmissions.push({ name, category })
  });
  HydrationBoundary({
    error: new Error("Minified React error #418; see docs"),
    reset: () => {}
  });
  assert.deepEqual(hydrationEmissions, [
    { name: "hydration_error", category: "hydration" }
  ]);

  /** @type {TestClientEvent[]} */
  const otherEmissions = [];
  const OtherBoundary = loadErrorBoundaryForTest({
    classifyReactError,
    /**
     * @param {string} name
     * @param {string} [category]
     */
    emitClientEvent: (name, category) => otherEmissions.push({ name, category })
  });
  OtherBoundary({ error: new Error("plain failure"), reset: () => {} });
  assert.deepEqual(otherEmissions, [
    { name: "client_error", category: "browser_exception" }
  ]);
});

test("Cloudflare rate-limit check and apply build Rulesets API requests", async () => {
  /** @type {FetchCall[]} */
  const calls = [];
  /**
   * @param {string} url
   * @param {RequestInit} init
   */
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: /** @type {FetchCall["init"]} */ (init) });
    if (init.method === "GET") {
      return Response.json({
        success: true,
        result: {
          rules: [
            {
              description: RATE_LIMIT_RULE_DESCRIPTION,
              enabled: false
            }
          ]
        }
      });
    }
    return Response.json({ success: true, result: { id: "ruleset_1" } });
  };

  assert.deepEqual(
    await checkRateLimitRule({
      zoneId: "zone_123",
      token: "token",
      fetchImpl
    }),
    { ok: true, present: true, enabled: false }
  );
  const payload = await applyRateLimitRule({
    zoneId: "zone_123",
    token: "token",
    fetchImpl
  });

  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[2].init.method, "PUT");
  assert.equal(
    calls[2].url,
    "https://api.cloudflare.com/client/v4/zones/zone_123/rulesets/phases/http_ratelimit/entrypoint"
  );
  assert.equal(calls[2].init.headers.Authorization, "Bearer token");
  const appliedBody = JSON.parse(String(calls[2].init.body));
  assert.equal(appliedBody.rules.length, 1);
  assert.equal(appliedBody.rules.at(-1).enabled, false);
  // The phase entrypoint PUT must not carry immutable ruleset fields; Cloudflare
  // rejects name/kind and the phase is implied by the URL.
  assert.ok(!("name" in appliedBody));
  assert.ok(!("kind" in appliedBody));
  assert.ok(!("phase" in appliedBody));
  assert.ok(payload.rules);
  assert.equal(payload.rules.at(-1)?.description, RATE_LIMIT_RULE_DESCRIPTION);
});

test("Cloudflare rate-limit apply surfaces API rejections clearly", async () => {
  await assert.rejects(
    applyRateLimitRule({
      zoneId: "zone_123",
      token: "token",
      fetchImpl: async () =>
        Response.json(
          {
            success: false,
            errors: [{ message: "plan does not support this rule" }]
          },
          { status: 403 }
        )
    }),
    /Cloudflare Rulesets API rejected the request \(403\): plan does not support this rule/
  );
});

test("Cloudflare rate-limit check and apply handle a fresh zone without the ruleset", async () => {
  /** @type {FetchCall[]} */
  const calls = [];
  /**
   * @param {string} url
   * @param {RequestInit} init
   */
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: /** @type {FetchCall["init"]} */ (init) });
    if (init.method === "GET") {
      return new Response(null, { status: 404 });
    }
    return Response.json({ success: true, result: { id: "ruleset_1" } });
  };

  assert.deepEqual(
    await checkRateLimitRule({ zoneId: "zone_123", token: "token", fetchImpl }),
    { ok: false, present: false, enabled: false }
  );

  const payload = await applyRateLimitRule({
    zoneId: "zone_123",
    token: "token",
    fetchImpl
  });

  const putCall = calls.find((call) => call.init.method === "PUT");
  assert.ok(putCall);
  const appliedBody = JSON.parse(String(putCall.init.body));
  assert.equal(appliedBody.rules.length, 1);
  assert.equal(appliedBody.rules[0].enabled, false);
  assert.equal(appliedBody.rules[0].description, RATE_LIMIT_RULE_DESCRIPTION);
  assert.ok(payload.rules);
  assert.equal(payload.rules.length, 1);
});

/**
 * @param {ClientEventsStub} clientEventsStub
 */
function loadErrorBoundaryForTest(clientEventsStub) {
  const source = readFileSync(resolve(REPO_ROOT, "app/error.tsx"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "app/error.tsx"
  }).outputText;
  const testModule = {
    exports: /** @type {Record<string, unknown>} */ ({})
  };

  vm.runInNewContext(
    compiled,
    {
      exports: testModule.exports,
      module: testModule,
      /**
       * @param {string} specifier
       */
      require(specifier) {
        if (specifier === "react") {
          return {
            /**
             * @param {() => void} callback
             */
            useEffect: (callback) => callback()
          };
        }
        if (specifier === "react/jsx-runtime") {
          return {
            /**
             * @param {unknown} type
             * @param {unknown} props
             */
            jsx: (type, props) => ({ type, props }),
            /**
             * @param {unknown} type
             * @param {unknown} props
             */
            jsxs: (type, props) => ({ type, props })
          };
        }
        if (specifier === "../src/client/client-events.ts") {
          return clientEventsStub;
        }
        return require(specifier);
      }
    },
    { filename: "app/error.tsx" }
  );

  return /** @type {(props: { error: Error, reset: () => void }) => unknown} */ (
    testModule.exports.default
  );
}
