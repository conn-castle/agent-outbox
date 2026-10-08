import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { loadModuleForTest } from "./helpers/transpiled-module.mjs";

const require = createRequire(import.meta.url);
const FIXTURE = "fixture_clerk_user_id";
const SESSION = {
  ok: true,
  accountId: "account-711",
  userId: "user-711",
  role: "owner",
  account: { accountId: "account-711", label: "My account", tier: "free" }
};
const PREVIEW = {
  setup_request_id: "setup +?",
  operation: "connect",
  flow: "browser",
  status: "pending",
  display_name: "Laptop Agent",
  local_caller_name: "laptop-agent",
  expires_at: "2026-10-08T04:00:00Z"
};
const QUERY = {};
const STARTED_AT = 1_700_000_000_000;

/**
 * The transpiled module boundary and heterogeneous React tree are dynamic.
 * @typedef {{ type: any, props: any }} PageElement
 * @typedef {{
 *   identityFailure?: string,
 *   identityControlFlow?: string,
 *   previewThrow?: boolean,
 *   commitThrow?: boolean,
 *   transactionFailure?: Record<string, unknown>,
 *   preview?: unknown,
 *   missing?: string[]
 * }} Behavior
 */

// Load actual pages, session helpers, views, UI and actions. Only framework and
// server dependencies are substituted; no page-transaction result is stubbed.
/** @param {Behavior} [behavior] */
function loadPages(behavior = {}) {
  /** @type {{ error: unknown, context: Record<string, unknown> }[]} */
  const reports = [];
  /** @type {(number | undefined)[]} */
  const timings = [];
  /** @type {Array<Record<string, unknown>>} */
  const transactions = [];
  /** @type {Array<Record<string, unknown>>} */
  const previews = [];
  let headerCalls = 0;
  const failure = new Error("original failure");
  const controlFlow = Object.assign(new Error("NEXT_REDIRECT"), {
    controlFlow: true
  });
  const navigation = {
    /** @param {unknown} error */
    unstable_rethrow(error) {
      if (/** @type {{controlFlow?: boolean}} */ (error)?.controlFlow)
        throw error;
    },
    /** @param {string} location */
    redirect(location) {
      throw Object.assign(new Error("NEXT_REDIRECT"), {
        controlFlow: true,
        location
      });
    }
  };
  /** @param {unknown} query @param {Record<string, unknown>} input */
  const preview = async (query, input) => {
    assert.equal(query, QUERY);
    previews.push({ ...input });
    if (behavior.previewThrow) throw failure;
    return behavior.preview ?? { ok: true, data: PREVIEW };
  };
  /** @type {Record<string, unknown>} */
  const external = {
    "next/navigation": navigation,
    "next/headers": {
      async headers() {
        headerCalls++;
        if (behavior.identityFailure === "headers") throw failure;
        if (behavior.identityControlFlow === "headers") throw controlFlow;
        return new Headers();
      }
    },
    "@clerk/nextjs/server": {
      auth: {
        /** @param {{unauthenticatedUrl: string}} input */
        async protect(input) {
          assert.equal(input.unauthenticatedUrl, "/sign-in");
          if (behavior.identityFailure === "auth") throw failure;
          if (behavior.identityControlFlow === "auth") throw controlFlow;
          return { userId: SESSION.userId };
        }
      }
    },
    "next/link": /** @param {Record<string, unknown>} props */ ({
      children,
      ...props
    }) => require("react/jsx-runtime").jsx("a", { ...props, children }),
    "src/server/caller-connect-clerk-fixture": {
      CALLER_CONNECT_FIXTURE_USER_ID_PARAM: FIXTURE,
      CALLER_CONNECT_FIXTURE_USER_ID_HEADER: "x-test-fixture-user",
      callerConnectClerkFixtureEnabled: () => false,
      /** @param {string | null | undefined} value */
      callerConnectFixtureClerkUserId(value) {
        if (behavior.identityFailure === "fixture") throw failure;
        return value || null;
      }
    },
    "src/server/correlation": {
      createCorrelationId: /** @param {string} prefix */ (prefix) =>
        `${prefix}_test`
    },
    "src/server/human-session": {
      requiredHumanSessionConfiguration: () => behavior.missing ?? [],
      /**
       * @param {Record<string, unknown>} input
       * @param {(query: unknown, session: typeof SESSION) => Promise<unknown>} callback
       */
      async runHumanAccountTransaction(input, callback) {
        transactions.push({ ...input });
        if (behavior.transactionFailure) return behavior.transactionFailure;
        const data = await callback(QUERY, SESSION);
        if (behavior.commitThrow) throw failure;
        return { ok: true, session: SESSION, data };
      }
    },
    "src/server/caller-connect": {
      getConnectBrowserApprovalPreview: preview,
      getConnectDeviceApprovalPreview: preview
    },
    "src/server/caller-credential-operations": {
      getCredentialOperationBrowserApprovalPreview: preview,
      getCredentialOperationDeviceApprovalPreview: preview
    },
    "src/server/caller-setup-requests": {
      getSetupRequestTerminalState: preview
    },
    "src/server/database": {},
    "src/server/logging": {
      /** @param {number | undefined} start */
      durationSinceMs(start) {
        timings.push(start);
        return 25;
      }
    },
    "src/server/sentry": {
      /** @param {unknown} error @param {Record<string, unknown>} context */
      reportRuntimeFailure(error, context) {
        reports.push({ error, context: { ...context } });
      }
    }
  };
  /** @type {Map<string, Record<string, any>>} */
  const modules = new Map();
  /** @param {string} relativePath @returns {Record<string, any>} */
  function load(relativePath) {
    if (modules.has(relativePath))
      return /** @type {Record<string, any>} */ (modules.get(relativePath));
    const result = loadModuleForTest(relativePath, {
      globals: {
        Error,
        Headers,
        URL,
        URLSearchParams,
        Date: class extends Date {
          static now() {
            return STARTED_AT;
          }
        },
        process: { env: {} }
      },
      fallbackRequire(specifier) {
        const resolved = specifier.startsWith(".")
          ? path.posix.normalize(
              path.posix.join(path.dirname(relativePath), specifier)
            )
          : specifier;
        if (Object.hasOwn(external, resolved)) return external[resolved];
        if (!specifier.startsWith(".")) return require(specifier);
        const file = [resolved, `${resolved}.ts`, `${resolved}.tsx`].find(
          (candidate) => existsSync(new URL(`../${candidate}`, import.meta.url))
        );
        assert.ok(file, `Missing test dependency ${resolved}`);
        return load(file);
      }
    });
    modules.set(relativePath, result);
    return result;
  }
  /** @param {string} operation @param {string} kind @param {Record<string, string | string[] | undefined>} [params] @returns {Promise<PageElement>} */
  async function run(operation, kind, params = {}) {
    const page = load(`app/caller/${operation}/${kind}/page.tsx`).default;
    let element = await page({ searchParams: Promise.resolve(params) });
    // Rotate/revoke route defaults return the real shared async page component.
    if (operation !== "connect") element = await element.type(element.props);
    return element;
  }
  return {
    run,
    reports,
    timings,
    transactions,
    previews,
    failure,
    controlFlow,
    get headerCalls() {
      return headerCalls;
    }
  };
}

/** @param {string} kind */
function params(kind) {
  return {
    [kind === "approve" ? "setup_request_id" : "user_code"]:
      kind === "approve" ? "setup-1" : "ABCD-EFGH",
    [FIXTURE]: "user_fixture"
  };
}

/** @param {ReturnType<typeof loadPages>} subject @param {string} operation @param {string} kind @param {string | undefined} accountId */
function assertReport(subject, operation, kind, accountId) {
  assert.equal(subject.reports.length, 1);
  assert.equal(subject.reports[0].error, subject.failure);
  assert.deepEqual(subject.timings, [STARTED_AT]);
  assert.deepEqual(subject.reports[0].context, {
    errorId: "caller_approval_test",
    request_id: `caller_${operation}_${kind}_page_req_test`,
    surface: "app",
    route: `/caller/${operation}/${kind}`,
    method: "GET",
    status_code: 503,
    duration_ms: 25,
    operation: `caller_${operation}_${kind === "approve" ? "browser" : "device"}_approval_preview`,
    account_id: accountId,
    message: "Caller approval flow failed unexpectedly."
  });
}

/** @param {PageElement} element @param {string} kind @param {Record<string, unknown>} error */
function assertConnectError(element, kind, error) {
  assert.equal(element.type.name, "ConnectErrorPage");
  assert.equal(element.props.title, "We couldn't load this request");
  assert.equal(
    element.props.description,
    kind === "approve"
      ? "The connection request could not be verified."
      : "The device connection request could not be verified."
  );
  assert.deepEqual({ ...element.props.error }, error);
}

// Expand actual server presentation components, retaining client components as
// leaves so hooks remain under React's control. This inspects form contracts.
/** @param {any} element @returns {PageElement[]} */
function nodes(element) {
  if (Array.isArray(element)) return element.flatMap(nodes);
  if (!element || typeof element !== "object") return [];
  const result = [element];
  if (
    typeof element.type === "function" &&
    !["ActionSubmitButton", "LocalExpiry"].includes(element.type.name)
  ) {
    result.push(...nodes(element.type(element.props)));
  } else {
    result.push(...nodes(element.props?.children));
  }
  return result;
}

for (const kind of ["approve", "device"]) {
  const missingSessionMessage =
    kind === "approve"
      ? "Human session is required after caller approval setup."
      : "Human session is required after device approval setup.";
  for (const boundary of ["headers", "auth", "fixture"]) {
    test(`connect ${kind}: unexpected ${boundary} failure reports then rejects without session`, async () => {
      const subject = loadPages({ identityFailure: boundary });
      await assert.rejects(
        subject.run("connect", kind, {
          ...params(kind),
          [FIXTURE]: boundary === "auth" ? undefined : "user_fixture"
        }),
        { message: missingSessionMessage }
      );
      assertReport(subject, "connect", kind, undefined);
      assert.deepEqual(subject.transactions, []);
      assert.deepEqual(subject.previews, []);
    });
  }
  for (const boundary of ["headers", "auth"]) {
    test(`connect ${kind}: ${boundary} control flow escapes unchanged without reporting`, async () => {
      const subject = loadPages({ identityControlFlow: boundary });
      // Omit fixture identity so auth.protect is reached.
      await assert.rejects(
        subject.run("connect", kind, { ...params(kind), [FIXTURE]: undefined }),
        (error) => error === subject.controlFlow
      );
      assert.deepEqual(subject.reports, []);
      assert.deepEqual(subject.previews, []);
    });
  }
  for (const status of [401, 503]) {
    test(`connect ${kind}: returned transaction ${status} remains its original panel`, async () => {
      const error = {
        ok: false,
        status,
        code:
          status === 401 ? "authentication_required" : "temporary_unavailable",
        message: "Human session resolution failed."
      };
      const subject = loadPages({ transactionFailure: error });
      assertConnectError(
        await subject.run("connect", kind, params(kind)),
        kind,
        error
      );
      assert.deepEqual(subject.reports, []);
      assert.deepEqual(subject.previews, []);
    });
  }
  for (const stage of ["previewThrow", "commitThrow"]) {
    test(`connect ${kind}: ${stage} after observed session keeps reported 503 panel`, async () => {
      const subject = loadPages({ [stage]: true });
      assertConnectError(
        await subject.run("connect", kind, params(kind)),
        kind,
        {
          status: 503,
          code: "temporary_unavailable",
          message: "Caller connect approval is temporarily unavailable."
        }
      );
      assertReport(subject, "connect", kind, SESSION.accountId);
      assert.equal(subject.previews.length, 1);
    });
  }
  test(`connect ${kind}: returned preview error retains copy without reporting`, async () => {
    const error = {
      status: 410,
      code: "setup_expired",
      message: "This request expired."
    };
    const subject = loadPages({ preview: { ok: false, error } });
    assertConnectError(
      await subject.run("connect", kind, params(kind)),
      kind,
      error
    );
    assert.deepEqual(subject.reports, []);
  });
  test(`connect ${kind}: successful preview retains view, identity, fields and actions`, async () => {
    const subject = loadPages();
    const element = await subject.run("connect", kind, params(kind));
    assert.equal(
      element.type.name,
      kind === "approve" ? "BrowserApprovalView" : "DeviceApprovalView"
    );
    assert.equal(element.props.session, SESSION);
    assert.equal(element.props.preview, PREVIEW);
    assert.equal(element.props.fixtureClerkUserId, "user_fixture");
    if (kind === "device") assert.equal(element.props.userCode, "ABCD-EFGH");
    const tree = nodes(element);
    const forms = tree.filter((node) => node.type === "form");
    assert.deepEqual(
      forms.map((node) => node.props.action.name),
      kind === "approve"
        ? ["approveBrowserConnect", "denyBrowserConnect"]
        : ["approveDeviceConnect", "denyDeviceConnect"]
    );
    for (const [index, form] of forms.entries()) {
      const inputs = nodes(form).filter((node) => node.type === "input");
      assert.deepEqual(
        inputs.map((node) => [node.props.name, node.props.value]),
        [
          [
            kind === "device" && index === 0 ? "userCode" : "setupRequestId",
            kind === "device" && index === 0
              ? "ABCD-EFGH"
              : PREVIEW.setup_request_id
          ],
          [FIXTURE, "user_fixture"]
        ]
      );
    }
    assert.deepEqual(subject.transactions, [
      {
        clerkUserId: "user_fixture",
        requestId: `caller_connect_${kind}_page_req_test`,
        route: `/caller/connect/${kind}`,
        method: "GET"
      }
    ]);
    assert.deepEqual(subject.previews, [
      kind === "approve"
        ? { setupRequestId: "setup-1" }
        : { userCode: "ABCD-EFGH", accountId: SESSION.accountId }
    ]);
    assert.deepEqual(subject.reports, []);
  });
  test(`connect ${kind}: configuration branch runs before identity resolution`, async () => {
    const subject = loadPages({
      missing: ["DATABASE_APP_ROLE_URL"],
      identityFailure: "headers"
    });
    const element = await subject.run("connect", kind, params(kind));
    assert.equal(element.type.name, "MissingConfigurationPanel");
    assert.equal(element.props.title, "Caller connect route is not configured");
    assert.deepEqual(element.props.missing, ["DATABASE_APP_ROLE_URL"]);
    assert.equal(subject.headerCalls, 0);
    assert.deepEqual(subject.reports, []);
  });
}

for (const status of [
  "approved",
  "exchanged",
  "pending",
  "denied",
  "expired",
  "failed"
]) {
  test(`connect device: ${status} retains success redirect or preview`, async () => {
    const subject = loadPages({
      preview: { ok: true, data: { ...PREVIEW, flow: "device", status } }
    });
    if (["approved", "exchanged"].includes(status)) {
      await assert.rejects(
        subject.run("connect", "device", params("device")),
        (error) => {
          assert.equal(
            /** @type {{location: string}} */ (error).location,
            `/caller/connect/success?${new URLSearchParams({
              flow: "device",
              setup_request_id: PREVIEW.setup_request_id,
              [FIXTURE]: "user_fixture"
            })}`
          );
          return (
            /** @type {{controlFlow: boolean}} */ (error).controlFlow === true
          );
        }
      );
    } else {
      const element = await subject.run("connect", "device", params("device"));
      assert.equal(element.type.name, "DeviceApprovalView");
      assert.equal(element.props.preview.status, status);
    }
    assert.deepEqual(subject.reports, []);
  });
}

test("connect early missing request and manual device entry precede configuration and session", async () => {
  const subject = loadPages({
    missing: ["DATABASE_APP_ROLE_URL"],
    identityFailure: "headers"
  });
  const missing = await subject.run("connect", "approve");
  assert.equal(missing.type.name, "ConnectErrorPage");
  assert.equal(missing.props.title, "This connection request is incomplete");
  assert.equal(
    missing.props.description,
    "The request is missing the information needed to continue."
  );
  assert.deepEqual(
    { ...missing.props.error },
    { status: 400, code: "invalid_request", message: "Missing setup request." }
  );
  const manual = await subject.run("connect", "device", {
    [FIXTURE]: "user_fixture"
  });
  assert.equal(manual.props.title, "Enter your device code");
  assert.equal(
    manual.props.description,
    "Use the code shown in the terminal where you started the connection."
  );
  const tree = nodes(manual);
  const form = tree.find((node) => node.type === "form");
  assert.ok(form);
  assert.equal(form.props.id, "enter-device-code");
  assert.equal(form.props.action.name, "previewDeviceConnect");
  assert.deepEqual(
    tree.filter((node) => node.type === "input").map((node) => node.props.name),
    ["userCode", FIXTURE]
  );
  assert.equal(subject.headerCalls, 0);
  assert.deepEqual(subject.reports, []);
});

for (const operation of ["rotate", "revoke"]) {
  for (const kind of ["approve", "device", "success", "error"]) {
    test(`${operation} ${kind}: pre-session exception retains established 503 copy`, async () => {
      const subject = loadPages({ identityFailure: "headers" });
      const element = await subject.run(operation, kind, {
        ...params(kind),
        setup_request_id: "setup-1",
        code: "setup_denied"
      });
      assert.equal(element.type.name, "ConnectErrorPage");
      assert.equal(
        element.props.title,
        kind === "device"
          ? "Verify device code"
          : kind === "approve"
            ? operation === "rotate"
              ? "Approve key rotation"
              : "Approve caller revoke"
            : kind === "success"
              ? operation === "rotate"
                ? "Rotation approved"
                : "Revoke approved"
              : operation === "rotate"
                ? "Rotation failed"
                : "Revoke failed"
      );
      assert.deepEqual(
        { ...element.props.error },
        {
          status: 503,
          code: "temporary_unavailable",
          message: `Caller ${operation} ${["approve", "device"].includes(kind) ? "approval" : "status"} is temporarily unavailable.`
        }
      );
      assert.equal(subject.reports.length, 1);
      assert.equal(subject.reports[0].error, subject.failure);
      assert.equal(subject.reports[0].context.account_id, undefined);
      assert.deepEqual(subject.previews, []);
    });
  }
}
