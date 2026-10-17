import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import * as correlation from "../src/server/correlation.ts";
import * as logging from "../src/server/logging.ts";
import * as observability from "../src/server/observability.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";
import { loadModuleForTest } from "./helpers/transpiled-module.mjs";

// Node's SDK shares a global carrier with edge; node --test isolates this file.
const require = createRequire(import.meta.url);
/** @type {typeof import("@sentry/nextjs")} */
const Sentry = require("../node_modules/@sentry/nextjs/build/cjs/server/index.js");
const runtime = /** @type {typeof import("../src/server/sentry.ts")} */ (
  loadModuleForTest("src/server/sentry.ts", {
    stubs: {
      "@sentry/nextjs": Sentry,
      "./logging.ts": logging,
      "./correlation.ts": correlation,
      "./observability.ts": observability
    },
    globals: { console, process }
  })
);
const MESSAGE = "Agent Outbox runtime failure";
/** @typedef {import("@sentry/nextjs").Event} Event */
/** @typedef {Parameters<NonNullable<ReturnType<NonNullable<ReturnType<typeof Sentry.getClient>>["getTransport"]>>["send"]>[0]} Envelope */

/** @param {string} message */
function nodeCauseOrigin(message) {
  return new SyntaxError(message);
}

/** @param {string} message @param {Error} cause */
function nodeSystemOrigin(message, cause) {
  return Object.assign(new TypeError(message, { cause }), {
    errno: -2,
    code: "ENOENT",
    syscall: "open"
  });
}

/** @param {string} message */
function nodeCodedOrigin(message) {
  try {
    Reflect.apply(readFileSync, undefined, [{}]);
    assert.fail("Node must reject an invalid path");
  } catch (error) {
    assert.ok(error instanceof TypeError);
    assert.ok("code" in error);
    assert.equal(error.code, "ERR_INVALID_ARG_TYPE");
    // Node formats the stack lazily, including its code and the entire message.
    error.message = message;
    assert.ok(
      error.stack?.startsWith(`TypeError [${error.code}]: ${message}\n`)
    );
    return error;
  }
}

test("real Node SDK verifies frames before source context and removes raw error context", async (t) => {
  await withProcessEnv(
    {
      APP_ENV: "production",
      NODE_ENV: "production",
      CI: undefined,
      SENTRY_DSN: "https://public@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@node-scrubbing-test"
    },
    async () => {
      // These values do not occur in the source ContextLines is allowed to read.
      const privateValue = `private-${randomUUID()}`;
      const fakeFunction = `${privateValue}-fn`;
      const fakeFile = `${privateValue}-file.js`;
      const message = `${privateValue}\nretry at ${privateValue}-host:5432\n    at ${fakeFunction} (${fakeFile}:1:2)`;
      /** @type {Envelope[]} */
      const envelopes = [];
      /** @type {Event[]} */
      const beforeScrub = [];
      const options = runtime.sentryRuntimeInitOptions();
      Sentry.init({
        ...options,
        tracesSampleRate: 0,
        beforeSend(event) {
          beforeScrub.push(structuredClone(event));
          return options.beforeSend(event);
        },
        transport: () => ({
          /** @param {Envelope} envelope */
          send: async (envelope) => {
            envelopes.push(structuredClone(envelope));
            return {};
          },
          flush: async () => true
        })
      });
      try {
        const client = Sentry.getClient();
        assert.ok(client);
        assert.ok(client.getIntegrationByName("NodeSystemError"));
        assert.ok(client.getIntegrationByName("ContextLines"));
        const codedId = Sentry.captureException(nodeCodedOrigin(message));
        assert.equal(
          runtime.captureRuntimeException(nodeCodedOrigin(message), {
            errorId: "node_coded",
            operation: "runtime.node_coded",
            route: "/human"
          }),
          true
        );
        const cause = nodeCauseOrigin(message);
        cause.name = `${privateValue}-invalid-type`;
        const systemError = Object.assign(nodeSystemOrigin(message, cause), {
          connectionString: `postgresql://${privateValue}@example.invalid/db`,
          customField: privateValue
        });
        systemError.name = `${privateValue}-system-type`;
        const systemId = Sentry.captureException(systemError);
        const syntheticException = new Error(message);
        assert.equal(typeof syntheticException.stack, "string");
        const undefinedId = Sentry.captureException(undefined, {
          syntheticException
        });
        const validId = Sentry.captureException(
          nodeCauseOrigin("ordinary failure")
        );
        const trustedFrames = [
          {
            filename: "trusted.ts",
            function: "trustedHandler",
            lineno: 42,
            context_line: "allowed source context",
            pre_context: ["before"],
            post_context: ["after"]
          }
        ];
        const trustedId = Sentry.captureEvent({
          exception: {
            values: [
              {
                type: "RangeError",
                value: message,
                stacktrace: { frames: trustedFrames }
              }
            ]
          }
        });
        const getterError = new TypeError(message);
        Object.defineProperty(getterError, "stack", {
          get() {
            throw new Error(privateValue);
          }
        });
        const runtimeReturned = runtime.captureRuntimeException(getterError, {
          errorId: "node_getter",
          operation: "runtime.node_getter",
          route: "/human"
        });
        Sentry.withScope((scope) => {
          scope.setContext("node_system_error", { customField: privateValue });
          scope.addEventProcessor(() => {
            const error = new Error(message);
            error.name = `${privateValue}-internal-type`;
            throw error;
          });
          Sentry.captureException(new Error("trigger internal SDK capture"));
        });
        assert.equal(await Sentry.flush(2000), true);
        const events = envelopes.flatMap(([, items]) =>
          items
            .filter(([header]) => header.type === "event")
            .map(([, event]) => /** @type {Event} */ (event))
        );
        /** @param {string} id */
        const eventById = (id) => {
          const event = events.find((event) => event.event_id === id);
          assert.ok(event);
          return event;
        };
        await t.test(
          "native Node coded errors retain their real call sites",
          () => {
            const direct = eventById(codedId);
            const captured = events.find(
              (event) => event.tags?.error_id === "node_coded"
            );
            assert.ok(captured);
            for (const event of [direct, captured]) {
              const exception = event.exception?.values?.[0];
              assert.equal(exception?.type, "TypeError");
              assert.equal(exception?.value, MESSAGE);
              assert.equal(event.tags?.stack_frames, undefined);
              const frames = exception?.stacktrace?.frames ?? [];
              assert.ok(
                frames.some((frame) => frame.function === "nodeCodedOrigin")
              );
              assert.equal(
                frames.some(
                  (frame) => frame.function === "sanitizedSentryException"
                ),
                false
              );
            }
            assert.deepEqual(captured.fingerprint, [
              "agent-outbox-runtime-failure",
              "TypeError",
              "runtime.node_coded",
              "/human"
            ]);
          }
        );
        await t.test(
          "NodeSystemError fixture actually exposes raw fields before scrub",
          () => {
            const original = beforeScrub.find(
              (event) => event.event_id === systemId
            );
            assert.ok(original);
            assert.equal(
              original.contexts?.node_system_error?.customField,
              privateValue
            );
            assert.equal(
              original.contexts?.node_system_error?.connectionString,
              systemError.connectionString
            );
            const event = eventById(systemId);
            assert.equal(event.contexts?.node_system_error, undefined);
            assert.equal(event.tags?.stack_frames, undefined);
            const values = event.exception?.values;
            assert.equal(values?.length, 2);
            for (const [source, origin] of [
              [undefined, "nodeSystemOrigin"],
              ["cause", "nodeCauseOrigin"]
            ]) {
              /** @type {import("@sentry/nextjs").Exception | undefined} */
              const value = values?.find(
                (value) => value.mechanism?.source === source
              );
              assert.ok(value);
              assert.equal(value.type, "Error");
              assert.equal(value.value, MESSAGE);
              assert.equal(
                value.mechanism?.type,
                source ? "chained" : "generic"
              );
              const frame = value.stacktrace?.frames?.find(
                (frame) => frame.function === origin
              );
              assert.ok(frame);
              assert.ok(
                frame.filename?.endsWith("sentry-node-scrubbing.test.mjs")
              );
              assert.ok(frame.context_line);
              assert.ok(frame.pre_context?.length);
              assert.ok(frame.post_context?.length);
            }
          }
        );
        await t.test(
          "undefined original with preformatted synthetic stack fails closed",
          () => {
            const event = eventById(undefinedId);
            assert.equal(
              event.exception?.values?.[0]?.mechanism?.synthetic,
              true
            );
            assert.equal(
              event.exception?.values?.[0]?.stacktrace?.frames?.length ?? 0,
              0
            );
            assert.equal(event.tags?.stack_frames, "omitted");
          }
        );
        await t.test(
          "valid names and trusted captureEvent context survive",
          () => {
            assert.equal(
              eventById(validId).exception?.values?.[0]?.type,
              "SyntaxError"
            );
            assert.deepEqual(
              eventById(trustedId).exception?.values?.[0]?.stacktrace?.frames,
              trustedFrames
            );
            assert.equal(eventById(trustedId).tags?.stack_frames, undefined);
          }
        );
        await t.test(
          "throwing runtime stack getter still captures safe event without frames",
          () => {
            assert.equal(runtimeReturned, true);
            const event = events.find(
              (event) => event.tags?.error_id === "node_getter"
            );
            assert.ok(event);
            assert.equal(event.exception?.values?.[0]?.type, "TypeError");
            assert.equal(event.exception?.values?.[0]?.value, MESSAGE);
            assert.equal(
              event.exception?.values?.[0]?.stacktrace?.frames?.length ?? 0,
              0
            );
            assert.deepEqual(event.fingerprint, [
              "agent-outbox-runtime-failure",
              "TypeError",
              "runtime.node_getter",
              "/human"
            ]);
          }
        );
        await t.test(
          "internal events bypass beforeSend and are scrubbed at transport",
          () => {
            const internal = events.find((event) =>
              event.exception?.values?.some(
                (value) => value.mechanism?.type === "internal"
              )
            );
            assert.ok(internal);
            assert.equal(
              beforeScrub.some((event) => event.event_id === internal.event_id),
              false
            );
            assert.equal(internal.exception?.values?.[0]?.type, "Error");
            assert.equal(internal.exception?.values?.[0]?.value, MESSAGE);
            assert.ok(
              internal.exception?.values?.[0]?.stacktrace?.frames?.length
            );
            assert.equal(internal.contexts?.node_system_error, undefined);
          }
        );
        await t.test(
          "runtime private values never enter envelopes or frame fields",
          () => {
            for (const event of events) {
              assert.equal(event.contexts?.node_system_error, undefined);
              for (const value of event.exception?.values ?? []) {
                for (const frame of value.stacktrace?.frames ?? []) {
                  for (const field of [
                    frame.function,
                    frame.filename,
                    frame.module
                  ]) {
                    assert.equal(field?.includes(privateValue) ?? false, false);
                  }
                }
              }
            }
            assert.equal(
              JSON.stringify(envelopes).includes(privateValue),
              false
            );
          }
        );
      } finally {
        assert.equal(await Sentry.close(2000), true);
      }
    }
  );
});
