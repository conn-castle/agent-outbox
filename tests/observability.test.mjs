import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { formatVersionLabel } from "../src/server/app-version.ts";
import { authenticateCallerApiRequest } from "../src/server/caller-api-auth.ts";
import {
  apiErrorResponse,
  apiRequestContext,
  apiResponseHeaders,
  apiSuccessResponse
} from "../src/server/api-errors.ts";
import {
  createBillingPortalSessionForAccount,
  createCheckoutSessionForAccount,
  handleStripeWebhookRequest
} from "../src/server/billing.ts";
import {
  createHumanAnswer,
  createHumanAnswerInTransaction
} from "../src/server/human-answer.ts";
import {
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../src/server/human-action-form.ts";
import { CLIENT_EVENT_BODY_BYTE_LIMIT } from "../src/shared/client-events-contract.ts";
import { SYSTEM_CONTRACT } from "../src/shared/system-contract.ts";
import {
  clientEventServerTestInternals,
  emitClientEventLog,
  handleClientEventsRequest
} from "../src/server/client-events.ts";
import {
  durationSinceMs,
  emitRuntimeLog,
  safeErrorName,
  safeLogEvent
} from "../src/server/logging.ts";
import { absoluteHttpOrigin } from "../src/server/env.ts";
import { readRawRequestBodyWithLimit } from "../src/server/request-body.ts";
import {
  cloudflareWebAnalyticsToken,
  runtimeRelease,
  sentryReleaseUploadConfig,
  sentryReleaseUploadEnabled
} from "../src/server/observability.ts";
import { runScheduledCleanup } from "../src/server/scheduled.ts";
import {
  sentryCaptureEnabled,
  sentryRuntimeInitOptions
} from "../src/server/sentry.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {(error: unknown, input: Record<string, unknown>) => {
 *   error_id: string,
 *   sentry_captured: boolean,
 *   log: Record<string, unknown>
 * }} RuntimeFailureReporterForTest
 */

/**
 * @param {() => Promise<void>} callback
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
 * @returns {import("react").ComponentType<{ children: import("react").ReactNode }>}
 */
function loadRootLayoutForTest() {
  const source = readFileSync(resolve(REPO_ROOT, "app/layout.tsx"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "app/layout.tsx"
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
      require: rootLayoutTestRequire
    },
    { filename: "app/layout.tsx" }
  );

  return /** @type {import("react").ComponentType<{ children: import("react").ReactNode }>} */ (
    testModule.exports.default
  );
}

function renderRootLayoutForTest() {
  const RootLayout = loadRootLayoutForTest();
  return renderToStaticMarkup(
    React.createElement(RootLayout, {
      children: React.createElement("main", null, "fixture")
    })
  );
}

/**
 * @param {{ withScope: Function, captureException: Function }} sentryStub
 * @returns {{ reportRuntimeFailure: RuntimeFailureReporterForTest }}
 */
function loadSentryModuleForTest(sentryStub) {
  const source = readFileSync(
    resolve(REPO_ROOT, "src/server/sentry.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "src/server/sentry.ts"
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
          return sentryStub;
        }
        if (specifier === "./logging.ts") {
          return { emitRuntimeLog, safeErrorName };
        }
        if (specifier === "./observability.ts") {
          return { runtimeRelease };
        }

        return require(specifier);
      }
    },
    { filename: "src/server/sentry.ts" }
  );

  return /** @type {{ reportRuntimeFailure: RuntimeFailureReporterForTest }} */ (
    testModule.exports
  );
}

/**
 * @param {(error: Error, input: Record<string, unknown>) => boolean} captureRuntimeException
 * @returns {Pick<typeof import("../src/server/api-errors.ts"), "apiErrorResponse">}
 */
function loadApiErrorsModuleForTest(captureRuntimeException) {
  const source = readFileSync(
    resolve(REPO_ROOT, "src/server/api-errors.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "src/server/api-errors.ts"
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
      Response,
      Headers,
      /**
       * @param {string} specifier
       */
      require(specifier) {
        if (specifier === "./correlation.ts") {
          return { createCorrelationId: () => "unused-correlation" };
        }
        if (specifier === "./logging.ts") {
          return { durationSinceMs, emitRuntimeLog };
        }
        if (specifier === "./sentry.ts") {
          return { captureRuntimeException };
        }

        return require(specifier);
      }
    },
    { filename: "src/server/api-errors.ts" }
  );

  return /** @type {Pick<typeof import("../src/server/api-errors.ts"), "apiErrorResponse">} */ (
    testModule.exports
  );
}

/**
 * @param {RuntimeFailureReporterForTest} reportRuntimeFailure
 * @returns {{
 *   createBillingPortalSessionForAccount: typeof createBillingPortalSessionForAccount,
 *   createCheckoutSessionForAccount: typeof createCheckoutSessionForAccount,
 *   handleStripeWebhookRequest: typeof handleStripeWebhookRequest
 * }}
 */
function loadBillingModuleForTest(reportRuntimeFailure) {
  const source = readFileSync(
    resolve(REPO_ROOT, "src/server/billing.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "src/server/billing.ts"
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
        if (specifier === "../shared/system-contract.ts") {
          return { SYSTEM_CONTRACT };
        }
        if (specifier === "./database.ts") {
          return {
            async runProductTransaction() {
              throw new Error("unexpected test transaction runner call");
            }
          };
        }
        if (specifier === "./input-schema.ts") {
          return { async readJsonBodyWithLimit() {} };
        }
        if (specifier === "./env.ts") {
          return { absoluteHttpOrigin };
        }
        if (specifier === "./logging.ts") {
          return { durationSinceMs, emitRuntimeLog, safeErrorName };
        }
        if (specifier === "./request-body.ts") {
          return { readRawRequestBodyWithLimit };
        }
        if (specifier === "./sentry.ts") {
          return { reportRuntimeFailure };
        }

        return require(specifier);
      }
    },
    { filename: "src/server/billing.ts" }
  );

  const billingModule = /** @type {{
    createBillingPortalSessionForAccount: typeof createBillingPortalSessionForAccount,
    createCheckoutSessionForAccount: typeof createCheckoutSessionForAccount,
    handleStripeWebhookRequest: typeof handleStripeWebhookRequest
  }} */ (testModule.exports);
  return billingModule;
}

/**
 * Loads billing-session.ts against a VM-compiled billing.ts whose Sentry
 * dependency is the supplied stub, so the account-lookup failure path runs the
 * real `billingRuntimeFailure` redaction and flow-based operation labelling
 * while the exception capture stays in-process.
 * @param {RuntimeFailureReporterForTest} reportRuntimeFailure
 * @returns {{ billingHumanSessionFromClerkUser: typeof import("../src/server/billing-session.ts").billingHumanSessionFromClerkUser }}
 */
function loadBillingSessionModuleForTest(reportRuntimeFailure) {
  const billingModule = loadBillingModuleForTest(reportRuntimeFailure);
  return /** @type {{ billingHumanSessionFromClerkUser: typeof import("../src/server/billing-session.ts").billingHumanSessionFromClerkUser }} */ (
    loadCommonJsModuleForTest("src/server/billing-session.ts", {
      "./billing.ts": billingModule,
      "./human-session.ts": {
        requiredHumanSessionConfiguration: () => [],
        runHumanAccountTransaction() {
          throw new Error("runHumanAccountTransaction should not run.");
        }
      }
    })
  );
}

/**
 * @param {RuntimeFailureReporterForTest} reportRuntimeFailure
 * @returns {{
 *   createHumanAnswer: typeof createHumanAnswer,
 *   humanAnswerUndoTransactionFailure: typeof import("../src/server/human-answer.ts").humanAnswerUndoTransactionFailure
 * }}
 */
function loadHumanAnswerModuleForTest(reportRuntimeFailure) {
  const source = readFileSync(
    resolve(REPO_ROOT, "src/server/human-answer.ts"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "src/server/human-answer.ts"
  }).outputText;
  const testModule = {
    exports: /** @type {Record<string, unknown>} */ ({})
  };

  vm.runInNewContext(
    compiled,
    {
      Buffer,
      console,
      exports: testModule.exports,
      module: testModule,
      process,
      URLSearchParams,
      /**
       * @param {string} specifier
       */
      require(specifier) {
        if (specifier === "node:buffer") {
          return require(specifier);
        }
        if (specifier === "node:crypto") {
          return require(specifier);
        }
        if (specifier === "../shared/system-contract.ts") {
          return { SYSTEM_CONTRACT };
        }
        if (specifier === "./accounting.ts") {
          return {
            /** @param {Record<string, unknown>} input */
            auditSafeLifecycleEvent(input) {
              return { ...input, metadata: input.metadata ?? {} };
            }
          };
        }
        if (specifier === "./api-errors.ts") {
          return { apiLimitMetadata: () => null };
        }
        if (specifier === "./caller-api-limits.ts") {
          return {
            async accountLimitProfileForAccount() {
              return null;
            },
            async enforceHumanFileUploadLimits() {
              return { ok: true };
            }
          };
        }
        if (specifier === "./cleanup.ts") {
          return { preReadUndoStatement: () => ({ sql: "", values: [] }) };
        }
        if (specifier === "./database.ts") {
          return {
            async runProductTransaction() {
              throw new Error("raw human answer database secret");
            }
          };
        }
        if (specifier === "./input-schema.ts") {
          return {
            compareUtcDateTimeValues: () => 0,
            isIanaTimeZone: () => true,
            isValidUtcDateTime: () => true
          };
        }
        if (specifier === "./logging.ts") {
          return { durationSinceMs, emitRuntimeLog };
        }
        if (specifier === "./output-files.ts") {
          return {
            safeAttachmentFilename: () => "upload.txt",
            safeContentType: () => "text/plain"
          };
        }
        if (specifier === "./sentry.ts") {
          return { reportRuntimeFailure };
        }

        return require(specifier);
      }
    },
    { filename: "src/server/human-answer.ts" }
  );

  const exportsForTest = /** @type {{
    createHumanAnswer: typeof createHumanAnswer,
    humanAnswerUndoTransactionFailure: typeof import("../src/server/human-answer.ts").humanAnswerUndoTransactionFailure
  }} */ (testModule.exports);
  return exportsForTest;
}

/**
 * @param {RuntimeFailureReporterForTest} reportRuntimeFailure
 * @returns {{ resolveHumanAccountSession: typeof import("../src/server/human-session.ts").resolveHumanAccountSession }}
 */
function loadHumanSessionModuleForTest(reportRuntimeFailure) {
  return /** @type {{ resolveHumanAccountSession: typeof import("../src/server/human-session.ts").resolveHumanAccountSession }} */ (
    loadCommonJsModuleForTest("src/server/human-session.ts", {
      "./authorization.ts": {
        authorizeAccountMembership() {
          throw new Error("authorizeAccountMembership should not run.");
        }
      },
      "./correlation.ts": {
        /** @param {string} prefix */
        createCorrelationId(prefix) {
          return `${prefix}_fallback`;
        }
      },
      "./database.ts": {
        async runProductTransaction() {
          throw new Error("raw billing session database secret");
        }
      },
      "./logging.ts": { durationSinceMs, emitRuntimeLog },
      "./sentry.ts": { reportRuntimeFailure }
    })
  );
}

/**
 * @param {string} relativePath
 * @param {Record<string, unknown>} stubs
 * @returns {Record<string, unknown>}
 */
function loadCommonJsModuleForTest(relativePath, stubs) {
  const source = readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: relativePath
  }).outputText;
  const testModule = {
    exports: /** @type {Record<string, unknown>} */ ({})
  };

  vm.runInNewContext(
    compiled,
    {
      Buffer,
      console,
      exports: testModule.exports,
      module: testModule,
      process,
      URLSearchParams,
      /**
       * @param {string} specifier
       */
      require(specifier) {
        if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
          return stubs[specifier];
        }

        return require(specifier);
      }
    },
    { filename: relativePath }
  );

  return testModule.exports;
}

/**
 * @param {string} routePath
 * @param {string} handlerModuleSpecifier
 * @param {string} handlerName
 * @param {string} expectedRoute
 * @returns {{ POST(request: Request): Promise<Response> }}
 */
function loadCallerRouteModuleForTest(
  routePath,
  handlerModuleSpecifier,
  handlerName,
  expectedRoute
) {
  /**
   * @param {Request} _request
   * @param {import("../src/server/api-errors.ts").ApiRequestContext} context
   * @param {unknown} _body
   */
  const handler = async (_request, context, _body) => {
    assert.equal(context.route, expectedRoute);
    return {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Caller route test failure.",
        errorId: "caller_route_failure_test"
      }
    };
  };
  const handlerStubs = /** @type {Record<string, unknown>} */ ({});
  handlerStubs[handlerName] = handler;

  return /** @type {{ POST(request: Request): Promise<Response> }} */ (
    loadCommonJsModuleForTest(routePath, {
      "../../../../../src/server/api-errors": {
        apiErrorResponse,
        apiRequestContext,
        apiSuccessResponse
      },
      "../../../../../src/server/input-schema": {
        async readJsonBodyWithLimit() {
          return { ok: true, value: {} };
        }
      },
      [handlerModuleSpecifier]: handlerStubs
    })
  );
}

/**
 * @param {RuntimeFailureReporterForTest} reportRuntimeFailure
 * @returns {{
 *   handleInputQueueRequest(
 *     request: Request,
 *     context: import("../src/server/api-errors.ts").ApiRequestContext,
 *     operation: "send" | "replace" | "delete",
 *     jsonBody: unknown
 *   ): Promise<{ ok: boolean, error?: import("../src/server/api-errors.ts").ApiErrorInput }>
 * }}
 */
function loadInputQueueModuleForTest(reportRuntimeFailure) {
  /**
   * @param {Request} _request
   * @param {import("../src/server/api-errors.ts").ApiRequestContext} context
   * @param {string} connectionString
   * @param {(query: (statement?: unknown) => Promise<{ rows: unknown[] }>, identity: { accountId: string, callerId: string }) => Promise<unknown>} callback
   */
  const runAuthenticatedCallerTransaction = async (
    _request,
    context,
    connectionString,
    callback
  ) => {
    assert.equal(connectionString, "postgresql://observability-test");
    assert.equal(context.requestId, "req-input-queue-observability");
    await callback(async () => ({ rows: [] }), {
      accountId: "00000000-0000-4000-8000-000000000201",
      callerId: "00000000-0000-4000-8000-000000000202"
    });
    throw new Error("raw input transaction secret");
  };

  return /** @type {ReturnType<typeof loadInputQueueModuleForTest>} */ (
    loadCommonJsModuleForTest("src/server/input-queue.ts", {
      "./accounting.ts": { async auditSafeLifecycleEvent() {} },
      "./caller-api-auth.ts": { runAuthenticatedCallerTransaction },
      "./caller-api-limits.ts": {
        async accountLimitProfileForAccount() {},
        async enforceAcceptedInputSubmissionLimits() {},
        async enforceCallerRequestLimits() {}
      },
      "./database.ts": {},
      "./input-schema.ts": {
        parseInputDeleteBody: /** @type {() => unknown} */ (() => ({})),
        parseInputSubmission: /** @type {() => unknown} */ (() => ({})),
        sha256Hex: /** @type {(value: string) => string} */ ((value) => value)
      },
      "./logging.ts": { durationSinceMs },
      "./sentry.ts": { reportRuntimeFailure }
    })
  );
}

/**
 * @param {RuntimeFailureReporterForTest} reportRuntimeFailure
 * @returns {{
 *   handleOutputFileDownloadRequest(
 *     request: Request,
 *     context: import("../src/server/api-errors.ts").ApiRequestContext,
 *     path: { outputResultId: string, fileId: string }
 *   ): Promise<{ ok: boolean, error?: import("../src/server/api-errors.ts").ApiErrorInput }>
 * }}
 */
function loadOutputFilesModuleForTest(reportRuntimeFailure) {
  /**
   * @param {Request} _request
   * @param {import("../src/server/api-errors.ts").ApiRequestContext} context
   * @param {string} connectionString
   * @param {(query: (statement?: unknown) => Promise<{ rows: unknown[] }>, identity: { accountId: string, callerId: string }) => Promise<unknown>} callback
   */
  const runAuthenticatedCallerTransaction = async (
    _request,
    context,
    connectionString,
    callback
  ) => {
    assert.equal(connectionString, "postgresql://observability-test");
    assert.equal(context.requestId, "req-output-file-observability");
    await callback(async () => ({ rows: [] }), {
      accountId: "00000000-0000-4000-8000-000000000301",
      callerId: "00000000-0000-4000-8000-000000000302"
    });
    throw new Error("raw output transaction secret");
  };

  return /** @type {ReturnType<typeof loadOutputFilesModuleForTest>} */ (
    loadCommonJsModuleForTest("src/server/output-files.ts", {
      "./accounting.ts": { async auditSafeLifecycleEvent() {} },
      "./api-errors.ts": { apiResponseHeaders },
      "./caller-api-auth.ts": { runAuthenticatedCallerTransaction },
      "./caller-api-limits.ts": {
        async accountLimitProfileForAccount() {},
        async enforceCallerRequestLimits() {}
      },
      "./database.ts": {},
      "./logging.ts": { durationSinceMs },
      "./sentry.ts": { reportRuntimeFailure }
    })
  );
}

/**
 * @param {import("../src/server/database.ts").TransactionContextStatement[]} calls
 * @param {{ accountTierRows: Array<Record<string, unknown>> }} rowsByKind
 * @returns {import("../src/server/database.ts").ProductTransactionQuery}
 */
function mockHumanAnswerQuery(calls, rowsByKind) {
  /**
   * @param {import("../src/server/database.ts").TransactionContextStatement} statement
   */
  const query = async (statement) => {
    calls.push(statement);

    if (statement.sql.includes("from public.agent_outbox_input_items")) {
      return queryResult([
        {
          input_item_id: "00000000-0000-4000-8000-000000000404",
          caller_item_id: "caller-item-observability",
          caller_item_id_hash: "hash-observability",
          status: "pending",
          current_revision: 3,
          non_file_payload_bytes: "100",
          updated_at: new Date("2026-06-29T09:00:00.000Z"),
          account_audit_id: "audit-account-observability",
          caller_audit_id: "audit-caller-observability"
        }
      ]);
    }
    if (statement.sql.includes("from public.agent_outbox_input_actions")) {
      return queryResult([
        {
          input_action_id: "action-observability",
          popup_kind: "file_upload",
          popup_payload: { accept_mime_types: ["text/plain"] }
        }
      ]);
    }
    if (
      statement.sql.includes(
        "from public.agent_outbox_input_action_popup_options"
      )
    ) {
      return queryResult([]);
    }
    if (
      statement.sql.includes("select tier from public.agent_outbox_accounts")
    ) {
      return queryResult(rowsByKind.accountTierRows);
    }
    if (statement.sql.includes("agent_outbox_account_limit_blocks")) {
      return queryResult([]);
    }

    return queryResult([]);
  };

  return /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {import("pg").QueryResult<Record<string, unknown>>}
 */
function queryResult(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

/**
 * @param {string} specifier
 * @returns {unknown}
 */
function rootLayoutTestRequire(specifier) {
  if (specifier === "react/jsx-runtime") {
    return require("react/jsx-runtime");
  }
  if (specifier === "@clerk/nextjs") {
    return { ClerkProvider: ClerkProviderStub };
  }
  if (specifier === "next/link") {
    return { __esModule: true, default: LinkStub };
  }
  if (specifier === "next/script") {
    return { __esModule: true, default: ScriptStub };
  }
  if (specifier === "../src/server/human-review-fixture-gate") {
    return { humanBrowserFixtureEnabled: () => false };
  }
  if (specifier === "../src/server/observability") {
    return { cloudflareWebAnalyticsToken };
  }
  if (specifier === "../src/server/app-version") {
    return { formatVersionLabel };
  }
  if (specifier === "../src/components/observability/ClientEventsInit") {
    return { ClientEventsInit: () => null };
  }
  if (specifier === "../src/components/actions/AppActionProvider") {
    return { AppActionProvider: ClerkProviderStub };
  }
  if (specifier === "../src/components/SiteFooter") {
    return { SiteFooter: () => React.createElement("footer") };
  }
  if (specifier === "../src/components/SiteHeader") {
    return { SiteHeader: () => React.createElement("header") };
  }
  if (
    specifier === "sonner/dist/styles.css" ||
    specifier === "./globals.css" ||
    specifier === "./review-workspace.css"
  ) {
    return {};
  }

  return require(specifier);
}

/**
 * @param {{ children?: import("react").ReactNode }} props
 */
function ClerkProviderStub({ children }) {
  return React.createElement(React.Fragment, null, children);
}

/**
 * @param {{ href: string | URL, children?: import("react").ReactNode, [key: string]: unknown }} props
 */
function LinkStub({ href, children, ...props }) {
  return React.createElement("a", { ...props, href: String(href) }, children);
}

/**
 * @param {{ strategy?: string, [key: string]: unknown }} props
 */
function ScriptStub({ strategy: _strategy, ...props }) {
  return React.createElement("script", props);
}

test("apiErrorResponse logs quota denials with safe operator metadata", async () => {
  const request = new Request("https://app.agent-outbox.dev/api/output/check", {
    headers: { "X-Request-ID": "req-observability" }
  });
  const context = apiRequestContext(request, "/api/output/check");
  const logs = await captureStructuredLogs(async () => {
    const response = apiErrorResponse(context, {
      status: 429,
      code: "rate_limit_exceeded",
      message: "Output check/read requests are temporarily rate limited.",
      log: { callerId: "00000000-0000-4000-8000-000000000002" },
      limit: {
        account_id: "00000000-0000-4000-8000-000000000001",
        operation_kind: "output_check_read",
        limit_name: "output_check_read_requests_per_account_per_minute",
        limit_reason_code: "output_check_read_rate_limited",
        limit_reason:
          "Output check/read requests are temporarily rate limited.",
        limit_resets_at: "2026-07-07T12:01:00.000Z",
        used_units: 121,
        limit_units: 120
      },
      upgrade: {
        message: "raw review content must not appear in logs",
        url: "https://example.test/upgrade"
      }
    });
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes("raw review content"), true);
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.equal(logs[0].error_id, context.correlationId);
  assert.equal(logs[0].request_id, "req-observability");
  assert.equal(logs[0].route, "/api/output/check");
  assert.equal(logs[0].method, "GET");
  assert.equal(logs[0].status_code, 429);
  assert.equal(logs[0].account_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(logs[0].caller_id, "00000000-0000-4000-8000-000000000002");
  assert.equal(
    logs[0].limit_name,
    "output_check_read_requests_per_account_per_minute"
  );
  assert.equal(logs[0].limit_reason_code, "output_check_read_rate_limited");
  assert.equal(logs[0].operation_kind, "output_check_read");
  assert.equal(logs[0].used_units, 121);
  assert.equal(logs[0].limit_units, 120);
  assert.equal(typeof logs[0].duration_ms, "number");
  assert.equal(JSON.stringify(logs).includes("raw review content"), false);
});

test("apiErrorResponse captures only unreported internal status-500 failures", async () => {
  /** @type {Array<{ error: Error, input: Record<string, unknown> }>} */
  const captures = [];
  const { apiErrorResponse: apiErrorResponseForTest } =
    loadApiErrorsModuleForTest((error, input) => {
      captures.push({ error, input });
      return true;
    });
  const context = {
    requestId: "req-api-boundary",
    correlationId: "corr-api-boundary",
    route: "/api/input/send",
    method: "POST",
    startedAtMs: Date.now()
  };

  const logs = await captureStructuredLogs(async () => {
    const internalResponse = apiErrorResponseForTest(context, {
      status: 500,
      code: "internal_error",
      message: "Safe public internal failure."
    });
    const unavailableResponse = apiErrorResponseForTest(context, {
      status: 503,
      code: "temporary_unavailable",
      message: "Safe public transient failure."
    });
    const reportedResponse = apiErrorResponseForTest(context, {
      status: 500,
      code: "internal_error",
      message: "Safe already-reported failure.",
      reported: true
    });

    assert.equal(internalResponse.status, 500);
    assert.equal(unavailableResponse.status, 503);
    assert.equal(reportedResponse.status, 500);
    const internalBody = await internalResponse.json();
    assert.equal(internalBody.correlation_id, context.correlationId);
    assert.equal("error_id" in internalBody.error, false);
  });

  assert.equal(captures.length, 1);
  assert.equal(captures[0].error.message, "API request failed");
  assert.equal(captures[0].input.errorId, context.correlationId);
  assert.equal(captures[0].input.operation, "api_error.internal_error");
  assert.equal(captures[0].input.route, context.route);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].status_code, 500);
  assert.equal(logs[0].error_id, context.correlationId);
  assert.equal(logs[0].sentry_captured, true);
  assert.equal(logs[1].status_code, 503);
  // Expected operational 5xx are not captured as Sentry exceptions, but the
  // log must say so explicitly for operator alerting on sentry_captured=false.
  assert.equal(logs[1].sentry_captured, false);
});

test("safe structured logs retain the computed Sentry capture outcome", () => {
  const safeEvent = safeLogEvent({
    level: "error",
    error_id: "err-safe-capture-result",
    sentry_captured: false,
    surface: "api",
    operation: "api_error.internal_error",
    message: "api request failed"
  });

  assert.equal(safeEvent.sentry_captured, false);
});

test("caller auth failures use server correlation id as error id", async () => {
  const logs = await captureStructuredLogs(async () => {
    const auth = await authenticateCallerApiRequest(
      new Request("https://app.agent-outbox.dev/api/output/check", {
        headers: { "X-Request-ID": "caller-supplied-request" }
      }),
      /** @type {import("../src/server/caller-api-auth.ts").CallerCredentialLookup} */ (
        async () => null
      ),
      {
        requestId: "caller-supplied-request",
        correlationId: "corr-server-generated",
        route: "/api/output/check",
        method: "GET",
        startedAtMs: Date.now()
      }
    );

    assert.equal(auth.ok, false);
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.equal(logs[0].error_id, "corr-server-generated");
  assert.equal(logs[0].request_id, "caller-supplied-request");
  assert.equal(logs[0].operation, "caller_api_auth");
});

test("apiErrorResponse logs file upload and download route failures with route templates", async () => {
  const contexts = [
    apiRequestContext(
      new Request("https://app.agent-outbox.dev/api/input/send", {
        method: "POST"
      }),
      "/api/input/send"
    ),
    apiRequestContext(
      new Request("https://app.agent-outbox.dev/api/output/result/files/file", {
        method: "GET"
      }),
      "/api/output/[output_result_id]/files/[file_id]"
    )
  ];

  const logs = await captureStructuredLogs(async () => {
    for (const context of contexts) {
      const response = apiErrorResponse(context, {
        status: 503,
        code: "temporary_unavailable",
        message: "File operation is temporarily unavailable.",
        errorId: "file_failure_test"
      });
      assert.equal(response.status, 503);
    }
  });

  assert.equal(logs.length, 2);
  assert.deepEqual(
    logs.map((log) => log.route),
    ["/api/input/send", "/api/output/[output_result_id]/files/[file_id]"]
  );
  for (const log of logs) {
    assert.equal(log.level, "error");
    assert.equal(log.error_id, "file_failure_test");
    assert.equal(log.operation, "api_error.temporary_unavailable");
    assert.equal(log.status_code, 503);
    assert.equal(typeof log.duration_ms, "number");
  }
});

test("human file upload limit failures log safe operator metadata", async () => {
  /** @type {import("../src/server/database.ts").TransactionContextStatement[]} */
  const calls = [];
  let readAttempted = false;
  class UploadFile extends File {
    async arrayBuffer() {
      readAttempted = true;
      return super.arrayBuffer();
    }
  }

  const file = new UploadFile(["raw upload body"], "secret-upload.txt", {
    type: "text/plain"
  });
  const logs = await captureStructuredLogs(async () => {
    const result = await createHumanAnswerInTransaction(
      mockHumanAnswerQuery(calls, {
        accountTierRows: [{ tier: "hosted_free" }]
      }),
      {
        accountId: "00000000-0000-4000-8000-000000000401",
        callerId: "00000000-0000-4000-8000-000000000402",
        humanUserId: "00000000-0000-4000-8000-000000000403",
        requestId: "req-human-file-upload",
        correlationId: "corr-human-file-upload",
        inputItemId: "00000000-0000-4000-8000-000000000404",
        expectedRevision: 3,
        actionValue: "upload",
        response: { kind: "file_upload", file }
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "upgrade_required");
  });

  assert.equal(readAttempted, false);
  assert.equal(
    calls.some((call) =>
      call.sql.includes("insert into public.agent_outbox_output_results")
    ),
    false
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.equal(logs[0].error_id, "corr-human-file-upload");
  assert.equal(logs[0].request_id, "req-human-file-upload");
  assert.equal(logs[0].surface, "app");
  assert.equal(logs[0].route, "/human");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].status_code, 402);
  assert.equal(logs[0].operation, "human_file_upload");
  assert.equal(logs[0].operation_kind, "file_upload");
  assert.equal(logs[0].account_id, "00000000-0000-4000-8000-000000000401");
  assert.equal(logs[0].caller_id, "00000000-0000-4000-8000-000000000402");
  assert.equal(logs[0].limit_name, "file_upload_enabled");
  assert.equal(logs[0].limit_reason_code, "file_upload_upgrade_required");
  assert.equal(typeof logs[0].duration_ms, "number");
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("secret-upload.txt"), false);
  assert.equal(serializedLogs.includes("raw upload body"), false);
});

test("human answer transaction failures share error id across structured log and Sentry", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const tagSnapshots = [];
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string, message?: string, stack?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Record<string, unknown>} */
      const tags = {};
      callback({
        setTag(name, value) {
          tags[name] = value;
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
      tagSnapshots.push(tags);
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(
        /** @type {{ name?: string, message?: string, stack?: string }} */ (
          error
        )
      );
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const { createHumanAnswer: createAnswer } =
    loadHumanAnswerModuleForTest(reportRuntimeFailure);
  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const result = await createAnswer("postgresql://human-answer-test", {
          accountId: "00000000-0000-4000-8000-000000000411",
          callerId: "00000000-0000-4000-8000-000000000412",
          humanUserId: "00000000-0000-4000-8000-000000000413",
          requestId: "req-human-answer-transaction",
          correlationId: "corr-human-answer-transaction",
          inputItemId: "00000000-0000-4000-8000-000000000414",
          expectedRevision: 3,
          actionValue: "approve",
          response: { kind: "none" }
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? null : result.code, "temporary_unavailable");
        assert.equal(
          result.ok ? null : result.message,
          "Human answer is temporarily unavailable."
        );
      })
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].error_id, "corr-human-answer-transaction");
  assert.equal(logs[0].request_id, "req-human-answer-transaction");
  assert.equal(logs[0].surface, "app");
  assert.equal(logs[0].route, "/human");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].status_code, 503);
  assert.equal(logs[0].operation, "human_answer_transaction");
  assert.equal(logs[0].account_id, "00000000-0000-4000-8000-000000000411");
  assert.equal(logs[0].caller_id, "00000000-0000-4000-8000-000000000412");
  assert.equal(capturedExceptions.length, 1);
  assert.equal(sentryContexts.length, 1);
  assert.equal(tagSnapshots[0].error_id, "corr-human-answer-transaction");
  assert.equal(tagSnapshots[0].operation, "human_answer_transaction");
  assert.equal(
    JSON.stringify(logs).includes("raw human answer database secret"),
    false
  );
});

test("human answer undo transaction failures share error id across structured log and Sentry", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const tagSnapshots = [];
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string, message?: string, stack?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Record<string, unknown>} */
      const tags = {};
      callback({
        setTag(name, value) {
          tags[name] = value;
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
      tagSnapshots.push(tags);
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(
        /** @type {{ name?: string, message?: string, stack?: string }} */ (
          error
        )
      );
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const { humanAnswerUndoTransactionFailure: undoFailure } =
    loadHumanAnswerModuleForTest(reportRuntimeFailure);
  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const result = undoFailure(
          new Error("raw human undo database secret"),
          {
            accountId: "00000000-0000-4000-8000-000000000421",
            callerId: "00000000-0000-4000-8000-000000000422",
            humanUserId: "00000000-0000-4000-8000-000000000423",
            requestId: "req-human-undo-transaction",
            correlationId: "corr-human-undo-transaction",
            outputResultId: "00000000-0000-4000-8000-000000000424"
          }
        );

        assert.equal(result.ok, false);
        assert.equal(result.ok ? null : result.code, "temporary_unavailable");
        assert.equal(
          result.ok ? null : result.message,
          "Human answer undo is temporarily unavailable."
        );
      })
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].error_id, "corr-human-undo-transaction");
  assert.equal(logs[0].request_id, "req-human-undo-transaction");
  assert.equal(logs[0].surface, "app");
  assert.equal(logs[0].route, "/human");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].status_code, 503);
  assert.equal(logs[0].operation, "human_answer_undo_transaction");
  assert.equal(logs[0].account_id, "00000000-0000-4000-8000-000000000421");
  assert.equal(logs[0].caller_id, "00000000-0000-4000-8000-000000000422");
  assert.equal(capturedExceptions.length, 1);
  assert.equal(sentryContexts.length, 1);
  assert.equal(tagSnapshots[0].error_id, "corr-human-undo-transaction");
  assert.equal(tagSnapshots[0].operation, "human_answer_undo_transaction");
  assert.equal(
    JSON.stringify(logs).includes("raw human answer database secret"),
    false
  );
});

test("caller connect rotate and revoke route failures log route templates", async () => {
  const routeCases = [
    {
      routePath: "app/api/caller/connect/exchange/route.ts",
      handlerModuleSpecifier: "../../../../../src/server/caller-connect",
      handlerName: "handleConnectExchangeRequest",
      route: "/api/caller/connect/exchange"
    },
    {
      routePath: "app/api/caller/rotate/exchange/route.ts",
      handlerModuleSpecifier:
        "../../../../../src/server/caller-credential-operations",
      handlerName: "handleRotateExchangeRequest",
      route: "/api/caller/rotate/exchange"
    },
    {
      routePath: "app/api/caller/revoke/confirm/route.ts",
      handlerModuleSpecifier:
        "../../../../../src/server/caller-credential-operations",
      handlerName: "handleRevokeConfirmRequest",
      route: "/api/caller/revoke/confirm"
    }
  ];

  const logs = await captureStructuredLogs(async () => {
    for (const routeCase of routeCases) {
      const routeModule = loadCallerRouteModuleForTest(
        routeCase.routePath,
        routeCase.handlerModuleSpecifier,
        routeCase.handlerName,
        routeCase.route
      );
      const response = await routeModule.POST(
        new Request(`https://app.agent-outbox.dev${routeCase.route}`, {
          method: "POST",
          headers: { "X-Request-ID": `req-${routeCase.handlerName}` },
          body: "{}"
        })
      );
      assert.equal(response.status, 503);
    }
  });

  assert.deepEqual(
    logs.map((log) => log.route),
    routeCases.map((routeCase) => routeCase.route)
  );
  for (const log of logs) {
    assert.equal(log.level, "error");
    assert.equal(log.error_id, "caller_route_failure_test");
    assert.equal(log.method, "POST");
    assert.equal(log.status_code, 503);
    assert.equal(log.operation, "api_error.temporary_unavailable");
    assert.equal(typeof log.duration_ms, "number");
  }
});

test("caller approval deny actions pass stable route labels to session logging", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const connectSessionInputs = [];
  const connectActions = /** @type {{
      denyBrowserConnect(formData: FormData): Promise<void>,
      denyDeviceConnect(formData: FormData): Promise<void>
    }} */ (
    loadCommonJsModuleForTest("app/caller/connect/actions.ts", {
      "next/navigation": {
        /** @param {string} path */
        redirect(path) {
          throw Object.assign(new Error("redirect"), { path });
        },
        /** @param {unknown} _error */
        unstable_rethrow(_error) {}
      },
      "../../../src/server/caller-connect": {
        approveConnectBrowserSetupRequest() {},
        approveConnectDeviceSetupRequest() {},
        denyConnectSetupRequest() {}
      },
      "../../../src/server/caller-connect-clerk-fixture": {
        CALLER_CONNECT_FIXTURE_USER_ID_PARAM: "fixture_clerk_user_id"
      },
      "../../../src/server/correlation": {
        /** @param {string} prefix */
        createCorrelationId(prefix) {
          return `${prefix}_test`;
        }
      },
      "./session": {
        /** @param {Record<string, unknown>} input */
        async runCallerConnectHumanTransaction(input) {
          connectSessionInputs.push(input);
          return {
            ok: false,
            status: 503,
            code: "temporary_unavailable",
            message: "No session."
          };
        },
        reportCallerApprovalFailure() {}
      }
    })
  );
  const connectForm = new FormData();
  connectForm.set("setupRequestId", "setup-connect");

  await assert.rejects(
    () => connectActions.denyBrowserConnect(connectForm),
    /redirect/
  );
  await assert.rejects(
    () => connectActions.denyDeviceConnect(connectForm),
    /redirect/
  );
  assert.deepEqual(
    connectSessionInputs.map((input) => input.route),
    ["/caller/connect/approve", "/caller/connect/device"]
  );

  /** @type {Array<Record<string, unknown>>} */
  const credentialSessionInputs = [];
  const credentialActions = /** @type {{
      denyRotateBrowser(formData: FormData): Promise<void>,
      denyRotateDevice(formData: FormData): Promise<void>,
      denyRevokeBrowser(formData: FormData): Promise<void>,
      denyRevokeDevice(formData: FormData): Promise<void>
    }} */ (
    loadCommonJsModuleForTest("app/caller/credential-actions.ts", {
      "next/navigation": {
        /** @param {string} path */
        redirect(path) {
          throw Object.assign(new Error("redirect"), { path });
        },
        /** @param {unknown} _error */
        unstable_rethrow(_error) {}
      },
      "../../src/server/caller-credential-operations": {
        approveCredentialOperationBrowserSetupRequest() {},
        approveCredentialOperationDeviceSetupRequest() {},
        denyCredentialOperationSetupRequest() {}
      },
      "../../src/server/caller-connect-clerk-fixture": {
        CALLER_CONNECT_FIXTURE_USER_ID_PARAM: "fixture_clerk_user_id"
      },
      "../../src/server/correlation": {
        /** @param {string} prefix */
        createCorrelationId(prefix) {
          return `${prefix}_test`;
        }
      },
      "./connect/session": {
        /** @param {Record<string, unknown>} input */
        async runCallerConnectHumanTransaction(input) {
          credentialSessionInputs.push(input);
          return {
            ok: false,
            status: 503,
            code: "temporary_unavailable",
            message: "No session."
          };
        },
        reportCallerApprovalFailure() {}
      }
    })
  );
  const credentialForm = new FormData();
  credentialForm.set("setupRequestId", "setup-credential");

  await assert.rejects(
    () => credentialActions.denyRotateBrowser(credentialForm),
    /redirect/
  );
  await assert.rejects(
    () => credentialActions.denyRotateDevice(credentialForm),
    /redirect/
  );
  await assert.rejects(
    () => credentialActions.denyRevokeBrowser(credentialForm),
    /redirect/
  );
  await assert.rejects(
    () => credentialActions.denyRevokeDevice(credentialForm),
    /redirect/
  );
  assert.deepEqual(
    credentialSessionInputs.map((input) => input.route),
    [
      "/caller/rotate/approve",
      "/caller/rotate/device",
      "/caller/revoke/approve",
      "/caller/revoke/device"
    ]
  );
});

test("human review server actions emit failure telemetry only on failure paths", async () => {
  /** @type {Array<{ name: string, producer?: string }>} */
  const emitted = [];
  /** @type {string[]} */
  const redirects = [];
  /**
   * @param {{
   *   transactionResult?: unknown,
   *   createHumanAnswerResult?: { ok: boolean, code?: string }
   * }} behavior
   */
  const loadHumanActions = (behavior) =>
    /** @type {{
        submitHumanAnswer(formData: FormData): Promise<void>,
        submitBulkHumanAnswers(formData: FormData): Promise<void>,
        undoHumanAnswer(formData: FormData): Promise<void>
      }} */ (
      loadCommonJsModuleForTest("app/human/actions.ts", {
        "@clerk/nextjs/server": {
          auth: {
            /** @param {unknown} _options */
            async protect(_options) {
              return { userId: "clerk-user-observability" };
            }
          }
        },
        "next/navigation": {
          /** @param {string} path */
          redirect(path) {
            redirects.push(path);
            throw Object.assign(new Error("redirect"), { path });
          }
        },
        "next/cache": { revalidatePath() {} },
        "../../src/server/correlation": {
          /** @param {string} prefix */
          createCorrelationId(prefix) {
            return `${prefix}_test`;
          }
        },
        "../../src/server/client-events": {
          /**
           * @param {{ name: string }} event
           * @param {{ producer?: string }} context
           */
          emitClientEventLog(event, context) {
            emitted.push({
              name: event.name,
              producer: context.producer
            });
          }
        },
        "../../src/server/human-review-fixture": {
          humanBrowserFixtureEnabled: () => false
        },
        "../../src/server/human-action-form": {
          parseBulkHumanAnswersForm,
          parseHumanAnswerForm,
          parseUndoHumanAnswerForm
        },
        "../../src/server/human-answer": {
          async createHumanAnswer() {
            return behavior.createHumanAnswerResult;
          },
          async createHumanAnswerInTransaction() {
            throw new Error("unused: transaction runner is stubbed");
          },
          async undoHumanAnswerBeforeReadInTransaction() {
            throw new Error("unused: transaction runner is stubbed");
          },
          humanAnswerTransactionFailure() {},
          humanAnswerUndoTransactionFailure() {}
        },
        "../../src/server/human-session": {
          async resolveHumanAccountSession() {
            return {
              ok: true,
              accountId: "00000000-0000-4000-8000-000000000701",
              userId: "00000000-0000-4000-8000-000000000702"
            };
          },
          async runHumanAccountTransaction() {
            return behavior.transactionResult;
          }
        },
        "../../src/shared/human-review-view": {
          HUMAN_REVIEW_VIEW_PARAM_KEYS: [
            "search",
            "status",
            "priority",
            "type",
            "sort",
            "dir",
            "then",
            "then_dir",
            "page"
          ]
        }
      })
    );

  const submitForm = new FormData();
  submitForm.set("inputItemId", "00000000-0000-4000-8000-000000000711");
  submitForm.set("callerId", "00000000-0000-4000-8000-000000000712");
  submitForm.set("expectedRevision", "1");
  submitForm.set("actionValue", "approve");
  submitForm.set("popupKind", "none");
  submitForm.set("view.page", "2");
  submitForm.set("view.then", "priority");
  submitForm.append("view.priority", "urgent");
  submitForm.append("view.priority", "high");

  const failingSubmit = loadHumanActions({
    transactionResult: {
      ok: true,
      data: { ok: false, code: "stale_input_revision" }
    }
  });
  await assert.rejects(
    () => failingSubmit.submitHumanAnswer(submitForm),
    /redirect/
  );
  assert.deepEqual(emitted, [
    {
      name: "human_action_failed",
      producer: "server_action"
    }
  ]);
  assert.match(redirects[0] ?? "", /error=stale_input_revision/);
  assert.match(
    redirects[0] ?? "",
    /priority=urgent&priority=high/,
    "server-action redirects must preserve repeated filters"
  );
  assert.match(redirects[0] ?? "", /page=2/);
  assert.match(redirects[0] ?? "", /then=priority/);

  emitted.length = 0;
  redirects.length = 0;
  const successfulSubmit = loadHumanActions({
    transactionResult: { ok: true, data: { ok: true } }
  });
  await assert.rejects(
    () => successfulSubmit.submitHumanAnswer(submitForm),
    /redirect/
  );
  assert.deepEqual(emitted, []);
  assert.match(redirects[0] ?? "", /notice=answer_submitted/);
  assert.match(redirects[0] ?? "", /page=2/);

  emitted.length = 0;
  redirects.length = 0;
  const invalidUploadForm = new FormData();
  invalidUploadForm.set("popupKind", "file_upload");
  const parseFailure = loadHumanActions({});
  await assert.rejects(
    () => parseFailure.submitHumanAnswer(invalidUploadForm),
    /redirect/
  );
  assert.deepEqual(emitted, [
    {
      name: "file_upload_failed",
      producer: "server_action"
    }
  ]);
  assert.match(redirects[0] ?? "", /error=invalid_request/);
  assert.match(redirects[0] ?? "", /failedActionKind=file_upload/);

  emitted.length = 0;
  redirects.length = 0;
  const undoForm = new FormData();
  undoForm.set("inputItemId", "00000000-0000-4000-8000-000000000711");
  undoForm.set("callerId", "00000000-0000-4000-8000-000000000712");
  undoForm.set("outputResultId", "00000000-0000-4000-8000-000000000713");
  const failingUndo = loadHumanActions({
    transactionResult: {
      ok: false,
      status: 503,
      code: "temporary_unavailable"
    }
  });
  await assert.rejects(() => failingUndo.undoHumanAnswer(undoForm), /redirect/);
  assert.deepEqual(emitted, [
    {
      name: "human_action_failed",
      producer: "server_action"
    }
  ]);
  assert.match(redirects[0] ?? "", /error=temporary_unavailable/);

  const bulkForm = new FormData();
  bulkForm.set("bulkActionValue", "approve");
  bulkForm.append(
    "bulkItem",
    JSON.stringify({
      inputItemId: "00000000-0000-4000-8000-000000000721",
      callerId: "00000000-0000-4000-8000-000000000712",
      expectedRevision: 1
    })
  );
  bulkForm.append(
    "bulkItem",
    JSON.stringify({
      inputItemId: "00000000-0000-4000-8000-000000000722",
      callerId: "00000000-0000-4000-8000-000000000712",
      expectedRevision: 1
    })
  );
  const previousAppRoleUrl = process.env.DATABASE_APP_ROLE_URL;
  process.env.DATABASE_APP_ROLE_URL = "postgresql://stubbed-app-role";
  try {
    emitted.length = 0;
    redirects.length = 0;
    const failingBulk = loadHumanActions({
      createHumanAnswerResult: { ok: false, code: "stale_input_revision" }
    });
    await assert.rejects(
      () => failingBulk.submitBulkHumanAnswers(bulkForm),
      /redirect/
    );
    assert.deepEqual(emitted, [
      {
        name: "human_action_failed",
        producer: "server_action"
      }
    ]);
    assert.match(redirects[0] ?? "", /error=bulk_answer_failed/);

    emitted.length = 0;
    redirects.length = 0;
    const successfulBulk = loadHumanActions({
      createHumanAnswerResult: { ok: true }
    });
    await assert.rejects(
      () => successfulBulk.submitBulkHumanAnswers(bulkForm),
      /redirect/
    );
    assert.deepEqual(emitted, []);
    assert.match(redirects[0] ?? "", /answered=2/);
  } finally {
    if (previousAppRoleUrl === undefined) {
      delete process.env.DATABASE_APP_ROLE_URL;
    } else {
      process.env.DATABASE_APP_ROLE_URL = previousAppRoleUrl;
    }
  }
});

test("caller approval failure reporter emits structured log and Sentry context", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const tagSnapshots = [];
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string, message?: string, stack?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Record<string, unknown>} */
      const tags = {};
      callback({
        setTag(name, value) {
          tags[name] = value;
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
      tagSnapshots.push(tags);
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(
        /** @type {{ name?: string, message?: string, stack?: string }} */ (
          error
        )
      );
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const sessionModule =
    /** @type {{ reportCallerApprovalFailure(error: unknown, input: Record<string, unknown>): ReturnType<RuntimeFailureReporterForTest> }} */ (
      loadCommonJsModuleForTest("app/caller/connect/session.ts", {
        "@clerk/nextjs/server": { auth: {} },
        "next/headers": { headers: async () => new Headers() },
        "../../../src/server/caller-connect": {
          async getConnectTerminalSetupState() {
            throw new Error("getConnectTerminalSetupState should not run.");
          }
        },
        "../../../src/server/caller-connect-clerk-fixture": {
          CALLER_CONNECT_FIXTURE_USER_ID_HEADER: "x-fixture-user",
          CALLER_CONNECT_FIXTURE_USER_ID_PARAM: "fixture_clerk_user_id",
          callerConnectClerkFixtureEnabled: () => false,
          callerConnectFixtureClerkUserId: () => null
        },
        "../../../src/server/correlation": {
          createCorrelationId: () => "caller_approval_report"
        },
        "../../../src/server/database": {
          async runProductTransaction() {
            throw new Error("runProductTransaction should not run.");
          }
        },
        "../../../src/server/human-session": {
          requiredHumanSessionConfiguration: () => [],
          async resolveHumanAccountSession() {
            throw new Error("resolveHumanAccountSession should not run.");
          }
        },
        "../../../src/server/logging": { durationSinceMs, emitRuntimeLog },
        "../../../src/server/sentry": { reportRuntimeFailure }
      })
    );

  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        sessionModule.reportCallerApprovalFailure(
          new Error("raw approval callback secret"),
          {
            requestId: "req-caller-approval",
            route: "/caller/connect/approve",
            method: "POST",
            operation: "caller_connect_browser_approval",
            session: {
              accountId: "00000000-0000-4000-8000-000000000601"
            },
            startedAtMs: Date.now()
          }
        );
      })
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].error_id, "caller_approval_report");
  assert.equal(logs[0].request_id, "req-caller-approval");
  assert.equal(logs[0].surface, "app");
  assert.equal(logs[0].route, "/caller/connect/approve");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].status_code, 503);
  assert.equal(logs[0].operation, "caller_connect_browser_approval");
  assert.equal(logs[0].account_id, "00000000-0000-4000-8000-000000000601");
  assert.equal(tagSnapshots[0].error_id, "caller_approval_report");
  assert.equal(tagSnapshots[0].operation, "caller_connect_browser_approval");
  assert.equal(tagSnapshots[0].route, "/caller/connect/approve");
  assert.equal(sentryContexts.length, 1);
  assert.equal(capturedExceptions.length, 1);
  assert.equal(
    JSON.stringify(logs).includes("raw approval callback secret"),
    false
  );
});

test("runtime failures set a Sentry fingerprint from safe discriminators", async () => {
  /** @type {unknown[]} */
  const fingerprints = [];
  /** @type {Array<{ name?: string, message?: string, stack?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      callback({
        setTag() {},
        setContext() {},
        setFingerprint(value) {
          fingerprints.push(value);
        }
      });
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(
        /** @type {{ name?: string, message?: string, stack?: string }} */ (
          error
        )
      );
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);

  await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        reportRuntimeFailure(new Error("raw fingerprint secret"), {
          errorId: "corr-fingerprint",
          surface: "app",
          route: "/human",
          operation: "human_answer_transaction",
          message: "Runtime failure fingerprint test."
        });
      })
  );

  // Grouping must be deterministic and derived only from safe discriminators so
  // unrelated failures reported through this helper never collapse into a single
  // issue and no sensitive text ever reaches the fingerprint.
  assert.equal(capturedExceptions.length, 1);
  assert.equal(fingerprints.length, 1);
  // The fingerprint array is created inside the sentry.ts VM realm, so copy it
  // into this realm before the deep equality check.
  assert.deepEqual(Array.from(/** @type {unknown[]} */ (fingerprints[0])), [
    "agent-outbox-runtime-failure",
    "Error",
    "human_answer_transaction",
    "/human"
  ]);
  assert.equal(
    JSON.stringify(fingerprints).includes("raw fingerprint secret"),
    false
  );
});

test("connect terminal setup state reports transaction exceptions", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const tagSnapshots = [];
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string, message?: string, stack?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Record<string, unknown>} */
      const tags = {};
      callback({
        setTag(name, value) {
          tags[name] = value;
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
      tagSnapshots.push(tags);
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(
        /** @type {{ name?: string, message?: string, stack?: string }} */ (
          error
        )
      );
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const sessionModule =
    /** @type {{ connectTerminalSetupState(query: import("../src/server/database.ts").ProductTransactionQuery, input: Record<string, unknown>): Promise<{ ok: boolean, error?: { status: number, code: string, message: string } }> }} */ (
      loadCommonJsModuleForTest("app/caller/connect/session.ts", {
        "@clerk/nextjs/server": { auth: {} },
        "next/headers": { headers: async () => new Headers() },
        "../../../src/server/caller-connect": {
          async getConnectTerminalSetupState() {
            throw new Error("getConnectTerminalSetupState should not run.");
          }
        },
        "../../../src/server/caller-connect-clerk-fixture": {
          CALLER_CONNECT_FIXTURE_USER_ID_HEADER: "x-fixture-user",
          CALLER_CONNECT_FIXTURE_USER_ID_PARAM: "fixture_clerk_user_id",
          callerConnectClerkFixtureEnabled: () => false,
          callerConnectFixtureClerkUserId: () => null
        },
        "../../../src/server/correlation": {
          createCorrelationId: () => "caller_terminal_report"
        },
        "../../../src/server/database": {},
        "../../../src/server/human-session": {
          requiredHumanSessionConfiguration: () => [],
          async resolveHumanAccountSession() {
            throw new Error("resolveHumanAccountSession should not run.");
          },
          async runHumanAccountTransaction() {
            throw new Error("runHumanAccountTransaction should not run.");
          }
        },
        "../../../src/server/logging": { durationSinceMs, emitRuntimeLog },
        "../../../src/server/sentry": { reportRuntimeFailure }
      })
    );

  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      DATABASE_APP_ROLE_URL: "postgresql://connect-terminal-test",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const result = await sessionModule.connectTerminalSetupState(
          /** @type {any} */ (
            async () => {
              throw new Error("raw connect terminal database secret");
            }
          ),
          {
            session: {
              accountId: "00000000-0000-4000-8000-000000000621",
              userId: "user_connect_terminal"
            },
            requestId: "req-connect-terminal",
            setupRequestId: "setup-connect-terminal",
            statuses: ["approved", "exchanged"],
            route: "/caller/connect/success",
            method: "GET",
            operation: "caller_connect_terminal_success",
            unavailableMessage:
              "Caller connect success is temporarily unavailable."
          }
        );

        assert.equal(result.ok, false);
        assert.equal(result.error?.status, 503);
        assert.equal(result.error?.code, "temporary_unavailable");
      })
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].error_id, "caller_terminal_report");
  assert.equal(logs[0].request_id, "req-connect-terminal");
  assert.equal(logs[0].route, "/caller/connect/success");
  assert.equal(logs[0].method, "GET");
  assert.equal(logs[0].operation, "caller_connect_terminal_success");
  assert.equal(logs[0].account_id, "00000000-0000-4000-8000-000000000621");
  assert.equal(tagSnapshots[0].error_id, "caller_terminal_report");
  assert.equal(tagSnapshots[0].route, "/caller/connect/success");
  assert.equal(sentryContexts.length, 1);
  assert.equal(capturedExceptions.length, 1);
  assert.equal(capturedExceptions[0].message, "Agent Outbox runtime failure");
  assert.equal(
    JSON.stringify(logs).includes("raw connect terminal database secret"),
    false
  );
  assert.equal(
    JSON.stringify(capturedExceptions).includes(
      "raw connect terminal database secret"
    ),
    false
  );
});

test("caller approval action wrappers report transaction exceptions before redirect", async () => {
  const session = {
    ok: true,
    accountId: "00000000-0000-4000-8000-000000000611",
    userId: "user_caller_approval",
    account: {
      accountId: "00000000-0000-4000-8000-000000000611",
      label: null,
      tier: "hosted_free",
      billingStatus: "not_applicable",
      billingGraceEndsAt: null
    },
    provisionedAccount: false,
    role: "owner"
  };
  /** @type {Array<Record<string, unknown>>} */
  const reports = [];
  const sessionStub = {
    /**
     * @param {Record<string, unknown>} _input
     * @param {(query: unknown, session: Record<string, unknown>) => Promise<unknown>} callback
     */
    async runCallerConnectHumanTransaction(_input, callback) {
      return callback({}, session);
    },
    /**
     * @param {unknown} _error
     * @param {Record<string, unknown>} input
     */
    reportCallerApprovalFailure(_error, input) {
      reports.push(input);
    }
  };
  const connectActions =
    /** @type {{ approveBrowserConnect(formData: FormData): Promise<void> }} */ (
      loadCommonJsModuleForTest("app/caller/connect/actions.ts", {
        "next/navigation": {
          /** @param {string} path */
          redirect(path) {
            throw Object.assign(new Error("redirect"), { path });
          },
          /** @param {unknown} _error */
          unstable_rethrow(_error) {}
        },
        "../../../src/server/caller-connect": {
          approveConnectBrowserSetupRequest() {
            throw new Error("raw approval transaction secret");
          },
          approveConnectDeviceSetupRequest() {},
          denyConnectSetupRequest() {}
        },
        "../../../src/server/caller-connect-clerk-fixture": {
          CALLER_CONNECT_FIXTURE_USER_ID_PARAM: "fixture_clerk_user_id"
        },
        "../../../src/server/correlation": {
          /** @param {string} prefix */
          createCorrelationId(prefix) {
            return `${prefix}_test`;
          }
        },
        "./session": sessionStub
      })
    );
  const credentialActions =
    /** @type {{ approveRotateDevice(formData: FormData): Promise<void> }} */ (
      loadCommonJsModuleForTest("app/caller/credential-actions.ts", {
        "next/navigation": {
          /** @param {string} path */
          redirect(path) {
            throw Object.assign(new Error("redirect"), { path });
          },
          /** @param {unknown} _error */
          unstable_rethrow(_error) {}
        },
        "../../src/server/caller-credential-operations": {
          approveCredentialOperationBrowserSetupRequest() {},
          approveCredentialOperationDeviceSetupRequest() {
            throw new Error("raw approval transaction secret");
          },
          denyCredentialOperationSetupRequest() {}
        },
        "../../src/server/caller-connect-clerk-fixture": {
          CALLER_CONNECT_FIXTURE_USER_ID_PARAM: "fixture_clerk_user_id"
        },
        "../../src/server/correlation": {
          /** @param {string} prefix */
          createCorrelationId(prefix) {
            return `${prefix}_test`;
          }
        },
        "./connect/session": sessionStub
      })
    );
  const browserForm = new FormData();
  browserForm.set("setupRequestId", "setup-connect");
  const deviceForm = new FormData();
  deviceForm.set("userCode", "ABCD-EFGH");

  await assert.rejects(
    () => connectActions.approveBrowserConnect(browserForm),
    /redirect/
  );
  await assert.rejects(
    () => credentialActions.approveRotateDevice(deviceForm),
    /redirect/
  );

  assert.deepEqual(
    reports.map((report) => ({
      requestId: report.requestId,
      route: report.route,
      method: report.method,
      operation: report.operation,
      accountId: /** @type {{ accountId?: unknown }} */ (report.session)
        .accountId
    })),
    [
      {
        requestId: "caller_connect_approve_req_test",
        route: "/caller/connect/approve",
        method: "POST",
        operation: "caller_connect_browser_approval",
        accountId: "00000000-0000-4000-8000-000000000611"
      },
      {
        requestId: "caller_rotate_device_req_test",
        route: "/caller/rotate/device",
        method: "POST",
        operation: "caller_rotate_device_approval",
        accountId: "00000000-0000-4000-8000-000000000611"
      }
    ]
  );
});

test("billing webhook signature failures log correlation without body or secret content", async () => {
  const stripe = /** @type {any} */ ({
    checkout: { sessions: { async create() {} } },
    billingPortal: { sessions: { async create() {} } },
    webhooks: {
      constructEvent() {
        const error = new Error("raw payload secret");
        error.name = "Bad Error raw payload secret";
        throw error;
      }
    }
  });
  const context = {
    requestId: "req-billing-webhook",
    correlationId: "corr-billing-webhook",
    route: "/api/billing/webhook",
    method: "POST",
    startedAtMs: Date.now()
  };

  const logs = await captureStructuredLogs(async () => {
    const result = await handleStripeWebhookRequest(
      new Request("https://app.agent-outbox.dev/api/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "signed" },
        body: '{"id":"evt_secret"}'
      }),
      context,
      {
        connectionString: "postgresql://billing-test",
        config: {
          secretKey: "sk_test_secret",
          webhookSecret: "whsec_secret",
          priceIds: {
            monthly: "price_monthly",
            yearly: "price_yearly"
          },
          portalConfigurationId: "bpc_secret",
          publicAppBaseUrl: "https://app.agent-outbox.dev"
        },
        stripe
      }
    );
    assert.equal(result.ok, false);
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.equal(logs[0].error_id, "corr-billing-webhook");
  assert.equal(logs[0].request_id, "req-billing-webhook");
  assert.equal(logs[0].route, "/api/billing/webhook");
  assert.equal(logs[0].status_code, 400);
  assert.equal(logs[0].operation, "stripe_webhook_signature");
  assert.equal(logs[0].error_name, "Error");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("evt_secret"), false);
  assert.equal(serialized.includes("raw payload secret"), false);
  assert.equal(serialized.includes("sk_test_secret"), false);
  assert.equal(serialized.includes("whsec_secret"), false);
});

test("billing webhook processing failures share one error id across structured log and Sentry", async () => {
  /** @type {Map<string, unknown>} */
  const tags = new Map();
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string, message?: string, stack?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      callback({
        setTag(name, value) {
          tags.set(name, value);
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(
        /** @type {{ name?: string, message?: string, stack?: string }} */ (
          error
        )
      );
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const { handleStripeWebhookRequest: handleWebhook } =
    loadBillingModuleForTest(reportRuntimeFailure);
  const stripe = /** @type {any} */ ({
    checkout: { sessions: { async create() {} } },
    billingPortal: { sessions: { async create() {} } },
    webhooks: {
      constructEvent() {
        return {
          id: "evt_secret_processing",
          created: 1783209600,
          type: "invoice.payment_failed",
          data: { object: {} }
        };
      }
    }
  });
  const context = {
    requestId: "req-billing-webhook-processing",
    correlationId: "corr-billing-webhook-processing",
    route: "/api/billing/webhook",
    method: "POST",
    startedAtMs: Date.now()
  };

  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const result = await handleWebhook(
          new Request("https://app.agent-outbox.dev/api/billing/webhook", {
            method: "POST",
            headers: { "stripe-signature": "signed" },
            body: '{"id":"evt_secret_processing"}'
          }),
          context,
          {
            connectionString: "postgresql://billing-test",
            config: {
              secretKey: "sk_test_secret",
              webhookSecret: "whsec_secret",
              priceIds: {
                monthly: "price_monthly",
                yearly: "price_yearly"
              },
              portalConfigurationId: "bpc_secret",
              publicAppBaseUrl: "https://app.agent-outbox.dev"
            },
            stripe,
            async runTransaction(connectionString, transactionContext) {
              assert.equal(connectionString, "postgresql://billing-test");
              assert.deepEqual(transactionContext, {
                requestId: "req-billing-webhook-processing",
                authSurface: "control_plane"
              });
              throw new Error("raw database transaction secret");
            }
          }
        );

        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.status, 503);
          assert.equal(result.error.code, "temporary_unavailable");
          assert.equal(result.error.errorId, "corr-billing-webhook-processing");
        }
      })
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].error_id, "corr-billing-webhook-processing");
  assert.equal(logs[0].request_id, "req-billing-webhook-processing");
  assert.equal(logs[0].route, "/api/billing/webhook");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].status_code, 503);
  assert.equal(logs[0].operation, "stripe_webhook_processing");
  assert.equal(typeof logs[0].duration_ms, "number");
  assert.equal(tags.get("error_id"), "corr-billing-webhook-processing");
  assert.equal(tags.get("operation"), "stripe_webhook_processing");
  assert.equal(tags.get("route"), "/api/billing/webhook");
  assert.equal(sentryContexts.length, 1);
  assert.equal(sentryContexts[0].name, "agent_outbox");
  assert.equal(
    sentryContexts[0].value.error_id,
    "corr-billing-webhook-processing"
  );
  assert.equal(sentryContexts[0].value.operation, "stripe_webhook_processing");
  assert.equal(capturedExceptions.length, 1);
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("evt_secret_processing"), false);
  assert.equal(
    serializedLogs.includes("raw database transaction secret"),
    false
  );
  assert.equal(serializedLogs.includes("sk_test_secret"), false);
  assert.equal(serializedLogs.includes("whsec_secret"), false);
});

test("billing checkout and portal Stripe failures share error ids across structured log and Sentry", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const tagSnapshots = [];
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Record<string, unknown>} */
      const tags = {};
      callback({
        setTag(name, value) {
          tags[name] = value;
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
      tagSnapshots.push(tags);
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(/** @type {{ name?: string }} */ (error));
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const {
    createBillingPortalSessionForAccount: createPortalSession,
    createCheckoutSessionForAccount: createCheckoutSession
  } = loadBillingModuleForTest(reportRuntimeFailure);
  const accountId = "00000000-0000-4000-8000-000000000501";
  const config = {
    secretKey: "sk_test_secret",
    webhookSecret: "whsec_secret",
    priceIds: {
      monthly: "price_monthly_secret",
      yearly: "price_yearly_secret"
    },
    portalConfigurationId: "bpc_secret",
    publicAppBaseUrl: "https://app.agent-outbox.dev"
  };
  const accountRow =
    /** @type {import("../src/server/billing.ts").BillingAccount} */ ({
      account_id: accountId,
      tier: "hosted_free",
      billing_status: "not_applicable",
      stripe_customer_id: "cus_secret"
    });
  const checkoutContext = {
    requestId: "req-billing-checkout",
    correlationId: "corr-billing-checkout",
    route: "/api/billing/checkout",
    method: "POST",
    startedAtMs: Date.now()
  };
  const portalContext = {
    requestId: "req-billing-portal",
    correlationId: "corr-billing-portal",
    route: "/api/billing/portal",
    method: "POST",
    startedAtMs: Date.now()
  };
  const stripe = /** @type {any} */ ({
    checkout: {
      sessions: {
        async create() {
          throw new Error("raw checkout stripe secret");
        }
      }
    },
    billingPortal: {
      sessions: {
        async create() {
          throw new Error("raw portal stripe secret");
        }
      }
    },
    webhooks: { constructEvent() {} }
  });
  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const checkoutStripe = await createCheckoutSession({
          account: accountRow,
          requestId: checkoutContext.requestId,
          interval: "monthly",
          context: checkoutContext,
          config,
          stripe
        });
        const portalStripe = await createPortalSession({
          account: accountRow,
          requestId: portalContext.requestId,
          context: portalContext,
          config,
          stripe
        });

        assert.deepEqual(
          [checkoutStripe, portalStripe].map((result) => ({
            ok: result.ok,
            status: result.ok ? null : result.error.status,
            code: result.ok ? null : result.error.code,
            errorId: result.ok ? null : result.error.errorId
          })),
          [
            {
              ok: false,
              status: 503,
              code: "temporary_unavailable",
              errorId: "corr-billing-checkout"
            },
            {
              ok: false,
              status: 503,
              code: "temporary_unavailable",
              errorId: "corr-billing-portal"
            }
          ]
        );
      })
  );

  assert.equal(logs.length, 2);
  assert.deepEqual(
    logs.map((log) => log.operation),
    ["stripe_checkout_session_create", "stripe_billing_portal_session_create"]
  );
  assert.deepEqual(
    logs.map((log) => log.error_id),
    ["corr-billing-checkout", "corr-billing-portal"]
  );
  assert.deepEqual(
    logs.map((log) => log.request_id),
    ["req-billing-checkout", "req-billing-portal"]
  );
  assert.deepEqual(
    logs.map((log) => log.route),
    ["/api/billing/checkout", "/api/billing/portal"]
  );
  for (const log of logs) {
    assert.equal(log.level, "error");
    assert.equal(log.method, "POST");
    assert.equal(log.status_code, 503);
    assert.equal(log.account_id, accountId);
    assert.equal(typeof log.duration_ms, "number");
  }
  assert.equal(capturedExceptions.length, 2);
  assert.equal(sentryContexts.length, 2);
  assert.deepEqual(
    tagSnapshots.map((tags) => tags.error_id),
    logs.map((log) => log.error_id)
  );
  assert.deepEqual(
    tagSnapshots.map((tags) => tags.operation),
    logs.map((log) => log.operation)
  );
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("raw checkout stripe secret"), false);
  assert.equal(serializedLogs.includes("raw portal stripe secret"), false);
  assert.equal(serializedLogs.includes("sk_test_secret"), false);
  assert.equal(serializedLogs.includes("cus_secret"), false);
});

test("billing account-lookup failures label the flow operation and redact secrets", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const tagSnapshots = [];
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Record<string, unknown>} */
      const tags = {};
      callback({
        setTag(name, value) {
          tags[name] = value;
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
      tagSnapshots.push(tags);
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(/** @type {{ name?: string }} */ (error));
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const { billingHumanSessionFromClerkUser } =
    loadBillingSessionModuleForTest(reportRuntimeFailure);
  const accountId = "00000000-0000-4000-8000-000000000511";

  /**
   * The callback resolves the session's account id and then throws inside the
   * account lookup query so the billing-session catch path runs.
   * @param {import("../src/server/billing-session.ts").BillingFlow} flow
   * @param {{ requestId: string, correlationId: string, route: string }} route
   */
  const runLookupFailure = (flow, route) =>
    billingHumanSessionFromClerkUser({
      context: { ...route, method: "POST", startedAtMs: Date.now() },
      flow,
      clerkUserId: `user_billing_${flow}`,
      runHumanTransaction: /** @type {any} */ (
        async (/** @type {any} */ _input, /** @type {any} */ callback) =>
          callback(
            async () => {
              throw new Error(`raw ${flow} account lookup secret`);
            },
            { accountId }
          )
      )
    });

  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const checkoutResult = await runLookupFailure("checkout", {
          requestId: "req-billing-checkout-lookup",
          correlationId: "corr-billing-checkout-lookup",
          route: "/api/billing/checkout"
        });
        const portalResult = await runLookupFailure("portal", {
          requestId: "req-billing-portal-lookup",
          correlationId: "corr-billing-portal-lookup",
          route: "/api/billing/portal"
        });

        assert.deepEqual(
          [checkoutResult, portalResult].map((result) => ({
            ok: result.ok,
            status: result.ok ? null : result.error.status,
            code: result.ok ? null : result.error.code,
            errorId: result.ok ? null : result.error.errorId,
            reported: result.ok ? null : result.error.reported
          })),
          [
            {
              ok: false,
              status: 503,
              code: "temporary_unavailable",
              errorId: "corr-billing-checkout-lookup",
              reported: true
            },
            {
              ok: false,
              status: 503,
              code: "temporary_unavailable",
              errorId: "corr-billing-portal-lookup",
              reported: true
            }
          ]
        );
      })
  );

  assert.equal(logs.length, 2);
  // The operation label is selected from the explicit flow, not the URL, so an
  // inverted mapping (checkout <-> portal) fails here.
  assert.deepEqual(
    logs.map((log) => log.operation),
    ["stripe_checkout_account_lookup", "stripe_billing_portal_account_lookup"]
  );
  assert.deepEqual(
    logs.map((log) => log.error_id),
    ["corr-billing-checkout-lookup", "corr-billing-portal-lookup"]
  );
  assert.deepEqual(
    logs.map((log) => log.route),
    ["/api/billing/checkout", "/api/billing/portal"]
  );
  for (const log of logs) {
    assert.equal(log.level, "error");
    assert.equal(log.method, "POST");
    assert.equal(log.status_code, 503);
    assert.equal(log.account_id, accountId);
    assert.equal(typeof log.duration_ms, "number");
  }
  assert.equal(capturedExceptions.length, 2);
  assert.equal(sentryContexts.length, 2);
  assert.deepEqual(
    tagSnapshots.map((tags) => tags.operation),
    ["stripe_checkout_account_lookup", "stripe_billing_portal_account_lookup"]
  );
  assert.deepEqual(
    tagSnapshots.map((tags) => tags.error_id),
    ["corr-billing-checkout-lookup", "corr-billing-portal-lookup"]
  );
  const serializedLogs = JSON.stringify(logs);
  assert.equal(
    serializedLogs.includes("raw checkout account lookup secret"),
    false
  );
  assert.equal(
    serializedLogs.includes("raw portal account lookup secret"),
    false
  );

  // Prove the operation label follows the explicit flow, not the request route:
  // a checkout flow reported against the portal route still labels checkout.
  const mismatchedLogs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        await runLookupFailure("checkout", {
          requestId: "req-billing-flow-mismatch",
          correlationId: "corr-billing-flow-mismatch",
          route: "/api/billing/portal"
        });
      })
  );
  assert.equal(mismatchedLogs.length, 1);
  assert.equal(
    mismatchedLogs[0].operation,
    "stripe_checkout_account_lookup",
    "operation label must follow the explicit flow, not the request route"
  );
});

test("billing session resolution failures share billing route error ids", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const tagSnapshots = [];
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Record<string, unknown>} */
      const tags = {};
      callback({
        setTag(name, value) {
          tags[name] = value;
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
      tagSnapshots.push(tags);
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(/** @type {{ name?: string }} */ (error));
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const { resolveHumanAccountSession } =
    loadHumanSessionModuleForTest(reportRuntimeFailure);

  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      DATABASE_APP_ROLE_URL: "postgresql://billing-session-test",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const result = await resolveHumanAccountSession({
          clerkUserId: "user_billing_session_failure",
          requestId: "req-billing-session-failure",
          errorId: "corr-billing-session-failure",
          route: "/api/billing/checkout",
          method: "POST",
          startedAtMs: Date.now()
        });

        assert.equal(result.ok, false);
        assert.equal(result.ok ? null : result.status, 503);
        assert.equal(result.ok ? null : result.code, "temporary_unavailable");
        assert.equal(
          result.ok ? null : result.message,
          "Human account session is temporarily unavailable."
        );
        assert.equal(
          result.ok ? null : result.errorId,
          "corr-billing-session-failure"
        );
        assert.equal(result.ok ? null : result.reported, true);
      })
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].error_id, "corr-billing-session-failure");
  assert.equal(logs[0].request_id, "req-billing-session-failure");
  assert.equal(logs[0].route, "/api/billing/checkout");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].status_code, 503);
  assert.equal(logs[0].operation, "human_account_session");
  assert.equal(tagSnapshots[0].error_id, "corr-billing-session-failure");
  assert.equal(tagSnapshots[0].operation, "human_account_session");
  assert.equal(tagSnapshots[0].route, "/api/billing/checkout");
  assert.equal(sentryContexts.length, 1);
  assert.equal(capturedExceptions.length, 1);
  assert.equal(
    JSON.stringify(logs).includes("raw billing session database secret"),
    false
  );
});

test("input queue and output file catch paths share error ids across logs and Sentry", async () => {
  /** @type {Array<{ tags: Map<string, unknown>, contexts: Array<{ name: string, value: Record<string, unknown> }> }>} */
  const sentryScopes = [];
  /** @type {Array<{ name?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      /** @type {Map<string, unknown>} */
      const tags = new Map();
      /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
      const contexts = [];
      callback({
        setTag(name, value) {
          tags.set(name, value);
        },
        setContext(name, value) {
          contexts.push({ name, value });
        },
        setFingerprint() {}
      });
      sentryScopes.push({ tags, contexts });
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(/** @type {{ name?: string }} */ (error));
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  const { handleInputQueueRequest: handleInputQueue } =
    loadInputQueueModuleForTest(reportRuntimeFailure);
  const { handleOutputFileDownloadRequest: handleOutputFileDownload } =
    loadOutputFilesModuleForTest(reportRuntimeFailure);
  const inputRequest = new Request(
    "https://app.agent-outbox.dev/api/input/send",
    { method: "POST" }
  );
  const inputContext = apiRequestContext(inputRequest, "/api/input/send");
  inputContext.requestId = "req-input-queue-observability";
  inputContext.correlationId = "corr-input-queue-observability";
  const outputRequest = new Request(
    "https://app.agent-outbox.dev/api/output/result/files/file",
    { method: "GET" }
  );
  const outputContext = apiRequestContext(
    outputRequest,
    "/api/output/[output_result_id]/files/[file_id]"
  );
  outputContext.requestId = "req-output-file-observability";
  outputContext.correlationId = "corr-output-file-observability";

  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      DATABASE_APP_ROLE_URL: "postgresql://observability-test",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const inputResult = await handleInputQueue(
          inputRequest,
          inputContext,
          "send",
          {}
        );
        assert.equal(inputResult.ok, false);
        if (!inputResult.ok) {
          assert.equal(inputResult.error?.status, 503);
          assert.equal(inputResult.error?.code, "temporary_unavailable");
          assert.equal(inputResult.error?.errorId, inputContext.correlationId);
          assert.equal(inputResult.error?.reported, true);
          await apiErrorResponse(inputContext, inputResult.error).json();
        }

        const outputResult = await handleOutputFileDownload(
          outputRequest,
          outputContext,
          {
            outputResultId: "output_result_observability",
            fileId: "output_file_observability"
          }
        );
        assert.equal(outputResult.ok, false);
        if (!outputResult.ok) {
          assert.equal(outputResult.error?.status, 503);
          assert.equal(outputResult.error?.code, "temporary_unavailable");
          assert.equal(
            outputResult.error?.errorId,
            outputContext.correlationId
          );
          assert.equal(outputResult.error?.reported, true);
          await apiErrorResponse(outputContext, outputResult.error).json();
        }
      })
  );

  assert.equal(logs.length, 2);
  assert.equal(sentryScopes.length, 2);
  assert.equal(capturedExceptions.length, 2);
  const inputLog = logs.find((log) => log.operation === "input_send");
  const outputLog = logs.find(
    (log) => log.operation === "output_file_download"
  );
  assert.ok(inputLog);
  assert.ok(outputLog);
  assert.equal(inputLog.error_id, "corr-input-queue-observability");
  assert.equal(inputLog.request_id, "req-input-queue-observability");
  assert.equal(inputLog.route, "/api/input/send");
  assert.equal(inputLog.method, "POST");
  assert.equal(inputLog.status_code, 503);
  assert.equal(inputLog.account_id, "00000000-0000-4000-8000-000000000201");
  assert.equal(inputLog.caller_id, "00000000-0000-4000-8000-000000000202");
  assert.equal(typeof inputLog.duration_ms, "number");
  assert.equal(outputLog.error_id, "corr-output-file-observability");
  assert.equal(outputLog.request_id, "req-output-file-observability");
  assert.equal(
    outputLog.route,
    "/api/output/[output_result_id]/files/[file_id]"
  );
  assert.equal(outputLog.method, "GET");
  assert.equal(outputLog.status_code, 503);
  assert.equal(outputLog.account_id, "00000000-0000-4000-8000-000000000301");
  assert.equal(outputLog.caller_id, "00000000-0000-4000-8000-000000000302");
  assert.equal(typeof outputLog.duration_ms, "number");
  assert.deepEqual(
    sentryScopes.map((scope) => scope.tags.get("error_id")),
    ["corr-input-queue-observability", "corr-output-file-observability"]
  );
  assert.deepEqual(
    sentryScopes.map((scope) => scope.tags.get("route")),
    ["/api/input/send", "/api/output/[output_result_id]/files/[file_id]"]
  );
  assert.deepEqual(
    sentryScopes.map((scope) => scope.tags.get("operation")),
    ["input_send", "output_file_download"]
  );
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("raw input transaction secret"), false);
  assert.equal(serializedLogs.includes("raw output transaction secret"), false);
});

test("scheduled cleanup failures log request account and duration without error text", async () => {
  const cleanupFailure = new Error("raw cleanup failure detail");
  const logs = await captureStructuredLogs(async () => {
    await assert.rejects(
      runScheduledCleanup({
        connectionString: "postgresql://cleanup-test",
        requestId: "req-cleanup-observability",
        now: new Date("2026-07-07T12:00:00.000Z"),
        async runTransaction(_connectionString, context, callback) {
          if (context.accountId) {
            throw cleanupFailure;
          }

          return await callback(
            /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
              async (statement) => {
                if (
                  statement.sql.includes("agent_outbox_cleanup_account_targets")
                ) {
                  return {
                    rows: [
                      {
                        account_id: "00000000-0000-4000-8000-000000000111",
                        tier: "hosted_free"
                      }
                    ],
                    rowCount: 1,
                    command: "SELECT",
                    oid: 0,
                    fields: []
                  };
                }

                return {
                  rows: [{ deleted_count: 0 }],
                  rowCount: 1,
                  command: "SELECT",
                  oid: 0,
                  fields: []
                };
              }
            )
          );
        }
      }),
      AggregateError
    );
  });

  assert.equal(logs.length, 2);
  const accountFailureLog = logs.find((log) => log.account_id);
  assert.ok(accountFailureLog);
  assert.equal(
    accountFailureLog.account_id,
    "00000000-0000-4000-8000-000000000111"
  );
  assert.equal(accountFailureLog.request_id, "req-cleanup-observability");
  assert.equal(accountFailureLog.operation, "maintenance.scheduled_cleanup");
  assert.equal(accountFailureLog.error_name, "Error");
  assert.equal(typeof accountFailureLog.duration_ms, "number");
  assert.equal(
    JSON.stringify(logs).includes("raw cleanup failure detail"),
    false
  );
});

test("client event endpoint logs only allowlisted content-safe fields", async () => {
  const request = new Request(
    "https://app.agent-outbox.dev/api/client-events",
    {
      method: "POST",
      headers: {
        origin: "https://app.agent-outbox.dev",
        referer: "https://app.agent-outbox.dev/human?filter=secret",
        "content-type": "application/json",
        "x-request-id": "caller-supplied-client-request"
      },
      body: JSON.stringify({
        events: [
          {
            name: "client_error",
            category: "browser_exception",
            route: "/client-supplied",
            message: "raw review content",
            stack: "secret stack trace"
          },
          {
            name: "unapproved_event",
            category: "browser_exception",
            route: "/client-supplied"
          }
        ]
      })
    }
  );

  const logs = await captureStructuredLogs(async () => {
    assert.deepEqual(await handleClientEventsRequest(request), {
      accepted: 1,
      dropped: 1
    });
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.match(String(logs[0].error_id), /^client_/);
  assert.match(String(logs[0].request_id), /^req_/);
  assert.notEqual(logs[0].request_id, "caller-supplied-client-request");
  assert.equal(logs[0].route, "/api/client-events");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[0].operation, "client_event.client_error");
  assert.equal(logs[0].client_event_name, "client_error");
  assert.equal(logs[0].client_event_category, "browser_exception");
  assert.equal(logs[0].event_count, 1);
  assert.equal(logs[0].sentry_captured, undefined);
  assert.equal(JSON.stringify(logs).includes("raw review content"), false);
  assert.equal(JSON.stringify(logs).includes("secret stack trace"), false);
});

test("GitHub sign-in failures reach the alertable browser-event path", async () => {
  clientEventServerTestInternals.resetBrowserSentryCaptureLimiter();
  const request = new Request(
    "https://app.agent-outbox.dev/api/client-events",
    {
      method: "POST",
      headers: {
        origin: "https://app.agent-outbox.dev",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        events: [
          {
            name: "github_sign_in_clerk_timeout",
            category: "browser_exception",
            message: "client-controlled detail must not survive"
          }
        ]
      })
    }
  );

  const logs = await captureStructuredLogs(async () => {
    assert.deepEqual(await handleClientEventsRequest(request), {
      accepted: 1,
      dropped: 0
    });
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].operation, "client_event.github_sign_in_clerk_timeout");
  assert.equal(logs[0].client_event_category, "authentication");
  assert.equal(logs[0].sentry_captured, false);
  assert.equal(
    JSON.stringify(logs).includes("client-controlled detail"),
    false
  );
});

test("GitHub sign-in Sentry capture attempts are rate limited per isolate", async () => {
  clientEventServerTestInternals.resetBrowserSentryCaptureLimiter();
  try {
    const logs = await captureStructuredLogs(async () => {
      for (const name of /** @type {const} */ ([
        "github_sign_in_clerk_error",
        "github_sign_in_clerk_timeout"
      ])) {
        emitClientEventLog(
          { name },
          {
            requestId: "req-client-event-rate-limit",
            route: "/api/client-events",
            producer: "browser"
          }
        );
      }
    });

    assert.equal(logs.length, 2);
    assert.equal(logs[0].client_event_category, "authentication");
    assert.equal(logs[0].sentry_captured, false);
    assert.equal(logs[0].sentry_capture_rate_limited, undefined);
    assert.equal(logs[1].level, "warn");
    assert.equal(logs[1].sentry_captured, false);
    assert.equal(logs[1].sentry_capture_rate_limited, true);
  } finally {
    clientEventServerTestInternals.resetBrowserSentryCaptureLimiter();
  }
});

test("server action failure events use trusted producer context without HTTP ingress fields", async () => {
  const logs = await captureStructuredLogs(async () => {
    emitClientEventLog(
      { name: "human_action_failed" },
      {
        requestId: "human-action-request",
        route: "/human",
        producer: "server_action"
      }
    );
    emitClientEventLog(
      { name: "file_upload_failed" },
      {
        requestId: "file-action-request",
        route: "/human",
        producer: "server_action"
      }
    );
  });

  assert.equal(logs.length, 2);
  assert.deepEqual(
    logs.map((log) => ({
      operation: log.operation,
      operation_kind: log.operation_kind,
      name: log.client_event_name,
      category: log.client_event_category,
      request_id: log.request_id,
      route: log.route
    })),
    [
      {
        operation: "client_event.human_action_failed",
        operation_kind: "server_action",
        name: "human_action_failed",
        category: "submission",
        request_id: "human-action-request",
        route: "/human"
      },
      {
        operation: "client_event.file_upload_failed",
        operation_kind: "server_action",
        name: "file_upload_failed",
        category: "upload",
        request_id: "file-action-request",
        route: "/human"
      }
    ]
  );
  for (const log of logs) {
    assert.equal("method" in log, false);
    assert.equal("status_code" in log, false);
    assert.equal("duration_ms" in log, false);
    assert.equal("event_count" in log, false);
  }
});

test("client event endpoint drops cross-origin and oversized batches without product-flow errors", async () => {
  const crossOrigin = new Request(
    "https://app.agent-outbox.dev/api/client-events",
    {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        "content-type": "application/json"
      },
      body: JSON.stringify({ events: [{ name: "client_error" }] })
    }
  );
  const oversized = new Request(
    "https://app.agent-outbox.dev/api/client-events",
    {
      method: "POST",
      headers: {
        origin: "https://app.agent-outbox.dev",
        "content-type": "application/json",
        "content-length": String(CLIENT_EVENT_BODY_BYTE_LIMIT + 1)
      },
      body: JSON.stringify({ events: [{ name: "client_error" }] })
    }
  );

  const logs = await captureStructuredLogs(async () => {
    assert.deepEqual(await handleClientEventsRequest(crossOrigin), {
      accepted: 0,
      dropped: 0
    });
    assert.deepEqual(await handleClientEventsRequest(oversized), {
      accepted: 0,
      dropped: 1
    });
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].operation, "client_event.dropped");
  assert.equal(logs[0].drop_reason, "declared_body_too_large");
  assert.equal(logs[0].status_code, 204);
});

test("client event endpoint drops streamed bodies exceeding the byte limit", async () => {
  // A ReadableStream body carries no content-length, so this exercises the
  // streaming byte-count guard rather than the declared-length shortcut.
  const streamedInit = {
    method: "POST",
    headers: {
      origin: "https://app.agent-outbox.dev",
      "content-type": "application/json"
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("x".repeat(CLIENT_EVENT_BODY_BYTE_LIMIT + 1))
        );
        controller.close();
      }
    }),
    duplex: "half"
  };
  const request = new Request(
    "https://app.agent-outbox.dev/api/client-events",
    streamedInit
  );

  const logs = await captureStructuredLogs(async () => {
    assert.deepEqual(await handleClientEventsRequest(request), {
      accepted: 0,
      dropped: 1
    });
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].operation, "client_event.dropped");
  assert.equal(logs[0].drop_reason, "body_too_large");
  assert.equal(logs[0].status_code, 204);
});

test("client event endpoint drops malformed batches with the matching drop reason", async () => {
  const cases = [
    {
      contentType: "text/plain",
      body: "{}",
      dropped: 1,
      dropReason: "content_type"
    },
    {
      contentType: "application/json",
      body: "not json",
      dropped: 1,
      dropReason: "invalid_json"
    },
    {
      contentType: "application/json",
      body: "{}",
      dropped: 1,
      dropReason: "invalid_shape"
    },
    {
      contentType: "application/json",
      body: JSON.stringify({ events: [{ name: "not_a_real_event" }] }),
      dropped: 1,
      dropReason: "no_allowed_events"
    }
  ];

  for (const testCase of cases) {
    const request = new Request(
      "https://app.agent-outbox.dev/api/client-events",
      {
        method: "POST",
        headers: {
          origin: "https://app.agent-outbox.dev",
          "content-type": testCase.contentType
        },
        body: testCase.body
      }
    );

    const logs = await captureStructuredLogs(async () => {
      assert.deepEqual(await handleClientEventsRequest(request), {
        accepted: 0,
        dropped: testCase.dropped
      });
    });

    assert.equal(logs.length, 1);
    assert.equal(logs[0].operation, "client_event.dropped");
    assert.equal(logs[0].drop_reason, testCase.dropReason);
    assert.equal(logs[0].status_code, 204);
  }
});

test("web analytics token renders only for production with a configured public token", () => {
  withProcessEnv(
    {
      APP_ENV: "development",
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: "public_token"
    },
    () => assert.equal(cloudflareWebAnalyticsToken(), null)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: undefined
    },
    () => assert.equal(cloudflareWebAnalyticsToken(), null)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: "unsafe token"
    },
    () => assert.equal(cloudflareWebAnalyticsToken(), null)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: "public_token-123"
    },
    () => assert.equal(cloudflareWebAnalyticsToken(), "public_token-123")
  );
});

test("RootLayout omits web analytics script outside production", () => {
  withProcessEnv(
    {
      APP_ENV: "development",
      CLERK_PUBLISHABLE_KEY: undefined,
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: "public_token-123"
    },
    () => {
      const html = renderRootLayoutForTest();
      assert.equal(
        html.includes("static.cloudflareinsights.com/beacon.min.js"),
        false
      );
      assert.equal(html.includes("data-cf-beacon"), false);
    }
  );
});

test("RootLayout omits web analytics script when production token is missing", () => {
  withProcessEnv(
    {
      APP_ENV: "production",
      CLERK_PUBLISHABLE_KEY: undefined,
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: undefined
    },
    () => {
      const html = renderRootLayoutForTest();
      assert.equal(
        html.includes("static.cloudflareinsights.com/beacon.min.js"),
        false
      );
      assert.equal(html.includes("data-cf-beacon"), false);
    }
  );
});

test("runtime logs populate release from the shared runtime source", async () => {
  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      GITHUB_SHA: undefined
    },
    () =>
      captureStructuredLogs(async () => {
        emitRuntimeLog({
          level: "info",
          surface: "api",
          route: "/api/runtime/log",
          method: "GET",
          status_code: 200,
          operation: "runtime.structured_log.canary",
          message: "structured log canary executed"
        });
      })
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].release, "agent-outbox@2026.07.07");
});

test("runtime canary failure routes include server request ids in reports", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const reports = [];
  let idCounter = 0;
  /** @param {string} prefix */
  const createCorrelationId = (prefix) =>
    `${prefix}_runtime_canary_${++idCounter}`;
  const nextServer = {
    NextResponse: {
      /**
       * @param {unknown} body
       * @param {ResponseInit | undefined} init
       */
      json(body, init) {
        return Response.json(body, init);
      }
    }
  };
  /** @type {RuntimeFailureReporterForTest} */
  const reportRuntimeFailure = (_error, input) => {
    reports.push(input);
    return {
      error_id: String(input.errorId),
      sentry_captured: false,
      log: {}
    };
  };
  const runtimeSentry = {
    isRuntimeSmokeRequest: () => false,
    reportRuntimeFailure,
    sentryCaptureConfigured: () => true
  };
  const http = {
    smokeBearerFailureResponse: () => null,
    /** @param {string[]} missing */
    missingConfigurationResponse: (missing) =>
      Response.json({ ok: false, missing }, { status: 503 })
  };
  /** @type {string[]} */
  const humanReviewCanaryRequestIds = [];

  const errorRoute =
    /** @type {{ GET(request: Request): Promise<Response> }} */ (
      loadCommonJsModuleForTest("app/api/runtime/error/route.ts", {
        "../../../../src/server/correlation": { createCorrelationId },
        "../../../../src/server/http": http,
        "../../../../src/server/logging": { durationSinceMs },
        "../../../../src/server/observability": {
          runtimeRelease: () => "agent-outbox@2026.07.07"
        },
        "../../../../src/server/sentry": runtimeSentry,
        "next/server": nextServer
      })
    );
  const sentryRoute =
    /** @type {{ POST(request: Request): Promise<Response> }} */ (
      loadCommonJsModuleForTest("app/api/runtime/sentry/route.ts", {
        "../../../../src/server/correlation": { createCorrelationId },
        "../../../../src/server/http": http,
        "../../../../src/server/logging": { durationSinceMs },
        "../../../../src/server/observability": {
          runtimeRelease: () => "agent-outbox@2026.07.07"
        },
        "../../../../src/server/sentry": runtimeSentry,
        "next/server": nextServer
      })
    );
  const databaseRoute =
    /** @type {{ GET(request: Request): Promise<Response> }} */ (
      loadCommonJsModuleForTest("app/api/runtime/database/route.ts", {
        "../../../../src/server/correlation": { createCorrelationId },
        "../../../../src/server/database": {
          async runTransactionContextCanary() {
            throw new Error("raw database canary detail");
          }
        },
        "../../../../src/server/human-review": {
          async runHumanReviewQueryCanary() {
            return true;
          }
        },
        "../../../../src/server/http": http,
        "../../../../src/server/logging": { durationSinceMs },
        "../../../../src/server/sentry": { reportRuntimeFailure },
        "next/server": nextServer
      })
    );
  const databaseHumanReviewFailureRoute =
    /** @type {{ GET(request: Request): Promise<Response> }} */ (
      loadCommonJsModuleForTest("app/api/runtime/database/route.ts", {
        "../../../../src/server/correlation": { createCorrelationId },
        "../../../../src/server/database": {
          async runTransactionContextCanary() {
            return {
              transactionContextMatched: true,
              restrictedRoleMatched: true
            };
          }
        },
        "../../../../src/server/human-review": {
          /**
           * @param {string} _connectionString
           * @param {string} requestId
           */
          async runHumanReviewQueryCanary(_connectionString, requestId) {
            humanReviewCanaryRequestIds.push(requestId);
            throw new Error("human review query failed");
          }
        },
        "../../../../src/server/http": http,
        "../../../../src/server/logging": { durationSinceMs },
        "../../../../src/server/sentry": {
          reportRuntimeFailure() {}
        },
        "next/server": nextServer
      })
    );

  await withProcessEnv(
    {
      APP_ENV: "development",
      DATABASE_APP_ROLE_URL: "postgresql://runtime-canary-test",
      SENTRY_DSN: undefined
    },
    async () => {
      assert.equal(
        (
          await errorRoute.GET(
            new Request("https://app.agent-outbox.dev/api/runtime/error")
          )
        ).status,
        500
      );
      assert.equal(
        (
          await sentryRoute.POST(
            new Request("https://app.agent-outbox.dev/api/runtime/sentry", {
              method: "POST"
            })
          )
        ).status,
        200
      );
      assert.equal(
        (
          await databaseRoute.GET(
            new Request("https://app.agent-outbox.dev/api/runtime/database")
          )
        ).status,
        502
      );
      const humanReviewFailureResponse =
        await databaseHumanReviewFailureRoute.GET(
          new Request("https://app.agent-outbox.dev/api/runtime/database")
        );
      assert.equal(humanReviewFailureResponse.status, 502);
      const humanReviewFailureBody = await humanReviewFailureResponse.json();
      assert.equal(humanReviewFailureBody.ok, false);
      assert.equal(humanReviewFailureBody.code, "database_canary_failed");
      assert.match(humanReviewFailureBody.error_id, /^db_runtime_canary_/);
    }
  );

  assert.equal(humanReviewCanaryRequestIds.length, 1);
  assert.match(humanReviewCanaryRequestIds[0] ?? "", /^req_runtime_canary_/);

  assert.deepEqual(
    reports.map((report) => report.route),
    ["/api/runtime/error", "/api/runtime/sentry", "/api/runtime/database"]
  );
  assert.deepEqual(
    reports.map((report) => report.operation),
    [
      "runtime.structured_error.canary",
      "runtime.sentry.canary",
      "runtime.database.canary"
    ]
  );
  for (const report of reports) {
    assert.match(String(report.request_id), /^req_runtime_canary_/);
  }
});

test("runtime sentry canary fails loud when production release metadata is missing", async () => {
  let reportCalled = false;
  const route = /** @type {{ POST(request: Request): Promise<Response> }} */ (
    loadCommonJsModuleForTest("app/api/runtime/sentry/route.ts", {
      "../../../../src/server/correlation": {
        createCorrelationId: () => "unused_sentry_canary_id"
      },
      "../../../../src/server/http": {
        smokeBearerFailureResponse: () => null,
        /** @param {string[]} missing */
        missingConfigurationResponse: (missing) =>
          Response.json(
            { ok: false, code: "missing_configuration", missing },
            { status: 503 }
          )
      },
      "../../../../src/server/logging": { durationSinceMs },
      "../../../../src/server/observability": { runtimeRelease: () => null },
      "../../../../src/server/sentry": {
        isRuntimeSmokeRequest: () => true,
        sentryCaptureConfigured: () => false,
        reportRuntimeFailure() {
          reportCalled = true;
          return { error_id: "unused", sentry_captured: false, log: {} };
        }
      },
      "next/server": {
        NextResponse: {
          /**
           * @param {unknown} body
           * @param {ResponseInit | undefined} init
           */
          json(body, init) {
            return Response.json(body, init);
          }
        }
      }
    })
  );

  await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: undefined,
      GITHUB_SHA: undefined
    },
    async () => {
      const response = await route.POST(
        new Request("https://app.agent-outbox.dev/api/runtime/sentry", {
          method: "POST"
        })
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false,
        code: "missing_configuration",
        missing: ["SENTRY_RELEASE"]
      });
    }
  );

  assert.equal(reportCalled, false);
});

test("runtime sentry canary reports configured capture while smoke suppresses emission", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const reports = [];
  const route = /** @type {{ POST(request: Request): Promise<Response> }} */ (
    loadCommonJsModuleForTest("app/api/runtime/sentry/route.ts", {
      "../../../../src/server/correlation": {
        /** @param {string} prefix */
        createCorrelationId(prefix) {
          return `${prefix}_configured`;
        }
      },
      "../../../../src/server/http": {
        smokeBearerFailureResponse: () => null,
        /** @param {string[]} missing */
        missingConfigurationResponse: (missing) =>
          Response.json(
            { ok: false, code: "missing_configuration", missing },
            { status: 503 }
          )
      },
      "../../../../src/server/logging": { durationSinceMs },
      "../../../../src/server/observability": {
        runtimeRelease: () => "agent-outbox@2026.07.07"
      },
      "../../../../src/server/sentry": {
        isRuntimeSmokeRequest: () => true,
        sentryCaptureConfigured: () => true,
        /**
         * @param {unknown} _error
         * @param {Record<string, unknown>} input
         */
        reportRuntimeFailure(_error, input) {
          reports.push(input);
          return {
            error_id: String(input.errorId),
            sentry_captured: false,
            log: {}
          };
        }
      },
      "next/server": {
        NextResponse: {
          /**
           * @param {unknown} body
           * @param {ResponseInit | undefined} init
           */
          json(body, init) {
            return Response.json(body, init);
          }
        }
      }
    })
  );

  await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      GITHUB_SHA: undefined
    },
    async () => {
      const response = await route.POST(
        new Request("https://app.agent-outbox.dev/api/runtime/sentry", {
          method: "POST"
        })
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        error_id: "sentry_configured",
        sentry_capture_enabled: false,
        sentry_capture_configured: true,
        sentry_capture_suppressed: true
      });
    }
  );

  assert.equal(reports.length, 1);
  assert.equal(reports[0].suppressCapture, true);
  assert.equal(reports[0].route, "/api/runtime/sentry");
});

test("reportRuntimeFailure shares one error id across structured log and Sentry", async () => {
  /** @type {Map<string, unknown>} */
  const tags = new Map();
  /** @type {Array<{ name: string, value: Record<string, unknown> }>} */
  const sentryContexts = [];
  /** @type {Array<{ name?: string, message?: string, stack?: string }>} */
  const capturedExceptions = [];
  const sentryStub = {
    /**
     * @param {(scope: {
     *   setTag(name: string, value: unknown): void,
     *   setContext(name: string, value: Record<string, unknown>): void,
     *   setFingerprint(value: unknown): void
     * }) => void} callback
     */
    withScope(callback) {
      callback({
        setTag(name, value) {
          tags.set(name, value);
        },
        setContext(name, value) {
          sentryContexts.push({ name, value });
        },
        setFingerprint() {}
      });
    },
    /**
     * @param {unknown} error
     */
    captureException(error) {
      capturedExceptions.push(
        /** @type {{ name?: string, message?: string, stack?: string }} */ (
          error
        )
      );
    }
  };
  const { reportRuntimeFailure } = loadSentryModuleForTest(sentryStub);
  /** @type {Array<{ error_id: string, sentry_captured: boolean }>} */
  const reports = [];
  const logs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        reports.push(
          reportRuntimeFailure(new TypeError("raw detail"), {
            errorId: "err_shared_observability",
            surface: "api",
            route: "/api/runtime/error",
            method: "GET",
            status_code: 503,
            duration_ms: 12,
            operation: "runtime.failure.test",
            message: "Runtime failure test.",
            request_id: "req_runtime_failure"
          })
        );
      })
  );

  assert.equal(reports.length, 1);
  assert.equal(sentryContexts.length, 1);
  assert.equal(capturedExceptions.length, 1);
  const report = reports[0];
  const sentryContext = sentryContexts[0];
  const capturedException = capturedExceptions[0];
  assert.equal(report.error_id, "err_shared_observability");
  assert.equal(report.sentry_captured, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].error_id, "err_shared_observability");
  assert.equal(logs[0].sentry_captured, true);
  assert.equal(tags.get("error_id"), "err_shared_observability");
  assert.equal(tags.get("operation"), "runtime.failure.test");
  assert.equal(tags.get("route"), "/api/runtime/error");
  assert.equal(sentryContext.name, "agent_outbox");
  assert.equal(sentryContext.value.error_id, "err_shared_observability");
  assert.equal(sentryContext.value.operation, "runtime.failure.test");
  assert.equal(capturedException.name, "Error");
  assert.equal(capturedException.message, "Agent Outbox runtime failure");
  assert.equal(String(capturedException.stack).includes("raw detail"), false);

  const disabledLogs = await withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: undefined,
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: "production"
    },
    () =>
      captureStructuredLogs(async () => {
        const disabledReport = reportRuntimeFailure(new Error("raw detail"), {
          errorId: "err_disabled_observability",
          surface: "api",
          route: "/api/runtime/error",
          operation: "runtime.failure.disabled",
          message: "Runtime failure test."
        });
        assert.equal(disabledReport.sentry_captured, false);
      })
  );
  assert.equal(disabledLogs.length, 1);
  assert.equal(disabledLogs[0].sentry_captured, false);
  assert.equal(capturedExceptions.length, 1);
});

test("sentry release metadata and source-map upload gate require the release path", () => {
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      GITHUB_SHA: undefined,
      SENTRY_ORG: "agent-outbox-org",
      SENTRY_PROJECT: "agent-outbox-web",
      SENTRY_AUTH_TOKEN: "token",
      AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: "1",
      AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: "1",
      CI: undefined,
      NODE_ENV: "production"
    },
    () => {
      assert.equal(runtimeRelease(), "agent-outbox@2026.07.07");
      assert.equal(
        sentryRuntimeInitOptions().release,
        "agent-outbox@2026.07.07"
      );
      assert.equal(sentryCaptureEnabled(), true);
      assert.deepEqual(sentryReleaseUploadConfig(), {
        org: "agent-outbox-org",
        project: "agent-outbox-web"
      });
      assert.equal(sentryReleaseUploadEnabled(), true);
    }
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      SENTRY_ORG: "agent-outbox-org",
      SENTRY_PROJECT: "agent-outbox-web",
      SENTRY_AUTH_TOKEN: "token",
      AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: "1",
      AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: undefined
    },
    () => assert.equal(sentryReleaseUploadEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      SENTRY_ORG: "agent-outbox-org",
      SENTRY_PROJECT: "agent-outbox-web",
      SENTRY_AUTH_TOKEN: "token",
      AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: undefined,
      AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: "1"
    },
    () => assert.equal(sentryReleaseUploadEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_RELEASE: undefined,
      GITHUB_SHA: undefined,
      SENTRY_ORG: "agent-outbox-org",
      SENTRY_PROJECT: "agent-outbox-web",
      SENTRY_AUTH_TOKEN: "token",
      AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: "1",
      AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: "1"
    },
    () => {
      assert.equal(sentryReleaseUploadEnabled(), false);
      assert.equal(sentryCaptureEnabled(), false);
      assert.equal("release" in sentryRuntimeInitOptions(), false);
    }
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      SENTRY_ORG: undefined,
      SENTRY_PROJECT: "agent-outbox-web",
      SENTRY_AUTH_TOKEN: "token",
      AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: "1",
      AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: "1"
    },
    () => {
      assert.equal(sentryReleaseUploadConfig(), null);
      assert.equal(sentryReleaseUploadEnabled(), false);
    }
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      SENTRY_ORG: "agent-outbox-org",
      SENTRY_PROJECT: undefined,
      SENTRY_AUTH_TOKEN: "token",
      AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: "1",
      AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: "1"
    },
    () => {
      assert.equal(sentryReleaseUploadConfig(), null);
      assert.equal(sentryReleaseUploadEnabled(), false);
    }
  );
});
