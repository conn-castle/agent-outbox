import assert from "node:assert/strict";
import test from "node:test";

import { loadModuleForTest } from "./helpers/transpiled-module.mjs";

const FIXTURE_PARAM = "fixture_clerk_user_id";
const SESSION = {
  ok: true,
  accountId: "00000000-0000-4000-8000-000000000711",
  userId: "user_caller_approval"
};
const CALLER = {
  caller_id: "caller-1",
  caller_slug: "laptop-agent",
  display_name: "Laptop Agent"
};

/**
 * Loads the caller approval server actions with stubbed domain, session, and
 * navigation modules. `redirect` throws so each action stops at its first
 * redirect, as in Next.js; `unstable_rethrow` rethrows errors marked as
 * framework control flow.
 *
 * @param {{
 *   domainResult?: () => unknown,
 *   transaction?: (callback: () => Promise<unknown>) => Promise<unknown>
 * }} [behavior]
 */
function loadActions(behavior = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const domainInputs = [];
  /** @type {Array<Record<string, unknown>>} */
  const sessionInputs = [];
  /** @type {Array<Record<string, unknown>>} */
  const reports = [];

  /**
   * @param {(input: Record<string, unknown>) => unknown} success
   */
  const domainFunction =
    (success) =>
    /**
     * @param {unknown} _query
     * @param {Record<string, unknown>} input
     */
    async (_query, input) => {
      // Copy out of the VM realm so deepStrictEqual compares plain objects.
      domainInputs.push({ ...input });
      const override = behavior.domainResult?.();
      if (override instanceof Error) throw override;
      return override ?? { ok: true, data: success(input) };
    };
  const browserApproval = () => ({
    setup_request_id: "setup-approved",
    setup_code: "code-123",
    callback_url: "http://127.0.0.1:4567/callback?state=local",
    caller: CALLER
  });
  const denied = () => ({ setup_request_id: "setup-denied", denied: true });

  const stubs = {
    "next/navigation": {
      /** @param {string} path */
      redirect(path) {
        throw Object.assign(new Error("redirect"), { path });
      },
      /** @param {unknown} error */
      unstable_rethrow(error) {
        if (/** @type {{ controlFlow?: boolean }} */ (error)?.controlFlow) {
          throw error;
        }
      }
    },
    "../../src/server/caller-connect": {
      approveConnectBrowserSetupRequest: domainFunction(browserApproval),
      approveConnectDeviceSetupRequest: domainFunction(() => ({
        setup_request_id: "setup-device",
        caller: CALLER
      })),
      denyConnectSetupRequest: domainFunction(denied)
    },
    "../../src/server/caller-credential-operations": {
      approveCredentialOperationBrowserSetupRequest:
        domainFunction(browserApproval),
      approveCredentialOperationDeviceSetupRequest: domainFunction((input) => ({
        setup_request_id: "setup-device",
        operation: input.operation,
        caller: CALLER
      })),
      denyCredentialOperationSetupRequest: domainFunction(denied)
    },
    "../../src/server/caller-connect-clerk-fixture": {
      CALLER_CONNECT_FIXTURE_USER_ID_PARAM: FIXTURE_PARAM
    },
    "../../src/server/correlation": {
      /** @param {string} prefix */
      createCorrelationId(prefix) {
        return `${prefix}_test`;
      }
    },
    "./connect/session": {
      /**
       * @param {Record<string, unknown>} input
       * @param {(query: unknown, session: unknown) => Promise<unknown>} callback
       */
      async runCallerConnectHumanTransaction(input, callback) {
        sessionInputs.push({ ...input });
        const run = () => callback({}, SESSION);
        if (behavior.transaction) return behavior.transaction(run);
        return { ok: true, session: SESSION, data: await run() };
      },
      /**
       * @param {unknown} _error
       * @param {Record<string, unknown>} input
       */
      reportCallerApprovalFailure(_error, input) {
        reports.push({ ...input });
      }
    }
  };

  const actions =
    /** @type {Record<string, (formData: FormData) => Promise<void>>} */ (
      loadModuleForTest("app/caller/approval-actions.ts", {
        stubs,
        globals: { URL, URLSearchParams }
      })
    );

  /**
   * @param {string} name
   * @param {Record<string, string>} fields
   */
  function run(name, fields) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    const action = actions[name];
    assert.equal(typeof action, "function", `missing action ${name}`);
    return action(formData);
  }

  /**
   * @param {string} name
   * @param {Record<string, string>} fields
   * @returns {Promise<string>}
   */
  async function redirectOf(name, fields) {
    /** @type {unknown} */
    let thrown;
    try {
      await run(name, fields);
    } catch (error) {
      thrown = error;
    }
    const path = /** @type {{ path?: string }} */ (thrown)?.path;
    assert.equal(typeof path, "string", `${name} did not redirect`);
    return /** @type {string} */ (path);
  }

  return { run, redirectOf, domainInputs, sessionInputs, reports };
}

/**
 * @param {string} path
 * @param {Record<string, string>} params in their expected order
 */
function url(path, params) {
  return `${path}?${new URLSearchParams(params)}`;
}

const OPERATIONS = [
  {
    operation: "connect",
    approveBrowser: "approveBrowserConnect",
    previewDevice: "previewDeviceConnect",
    approveDevice: "approveDeviceConnect",
    denyBrowser: "denyBrowserConnect",
    denyDevice: "denyDeviceConnect",
    deviceSuccessParams: {
      flow: "device",
      setup_request_id: "setup-device",
      caller: "Laptop Agent"
    },
    deniedMessage: "Caller setup was canceled.",
    domainInput: {}
  },
  ...["rotate", "revoke"].map((operation) => {
    const Name = operation[0].toUpperCase() + operation.slice(1);
    return {
      operation,
      approveBrowser: `approve${Name}Browser`,
      previewDevice: `preview${Name}Device`,
      approveDevice: `approve${Name}Device`,
      denyBrowser: `deny${Name}Browser`,
      denyDevice: `deny${Name}Device`,
      deviceSuccessParams: { setup_request_id: "setup-device" },
      deniedMessage: `Caller ${operation} was canceled.`,
      domainInput: { operation }
    };
  })
];

for (const op of OPERATIONS) {
  const fixture = { [FIXTURE_PARAM]: "user_fixture" };
  const errorPage = `/caller/${op.operation}/error`;

  test(`${op.operation} approval actions redirect to the operation's success targets`, async () => {
    const { redirectOf, domainInputs, sessionInputs } = loadActions();

    assert.equal(
      await redirectOf(op.approveBrowser, {
        setupRequestId: " setup-1 ",
        ...fixture
      }),
      url("http://127.0.0.1:4567/callback", {
        state: "local",
        status: "approved",
        setup_request_id: "setup-approved",
        setup_code: "code-123"
      })
    );
    assert.equal(
      await redirectOf(op.previewDevice, { userCode: "ABCD-EFGH", ...fixture }),
      url(`/caller/${op.operation}/device`, {
        user_code: "ABCD-EFGH",
        ...fixture
      })
    );
    assert.equal(
      await redirectOf(op.approveDevice, { userCode: "ABCD-EFGH", ...fixture }),
      url(`/caller/${op.operation}/success`, {
        ...op.deviceSuccessParams,
        ...fixture
      })
    );
    for (const deny of [op.denyBrowser, op.denyDevice]) {
      assert.equal(
        await redirectOf(deny, { setupRequestId: "setup-1", ...fixture }),
        url(errorPage, {
          status: "200",
          code: "setup_denied",
          message: op.deniedMessage,
          ...fixture,
          setup_request_id: "setup-denied"
        })
      );
    }

    const approval = { accountId: SESSION.accountId, userId: SESSION.userId };
    const denial = {
      ...op.domainInput,
      setupRequestId: "setup-1",
      accountId: SESSION.accountId
    };
    assert.deepEqual(domainInputs, [
      { ...op.domainInput, setupRequestId: "setup-1", ...approval },
      { ...op.domainInput, userCode: "ABCD-EFGH", ...approval },
      denial,
      denial
    ]);
    assert.deepEqual(
      sessionInputs,
      [
        ["approve_req", "approve"],
        ["device_req", "device"],
        ["deny_req", "approve"],
        ["deny_req", "device"]
      ].map(([requestKind, page]) => ({
        requestId: `caller_${op.operation}_${requestKind}_test`,
        fixtureClerkUserId: "user_fixture",
        route: `/caller/${op.operation}/${page}`,
        method: "POST"
      }))
    );
  });

  test(`${op.operation} approval actions redirect failures to the operation's error page`, async () => {
    const missing = loadActions();
    for (const [name, message] of [
      [op.approveBrowser, "Missing setup request."],
      [op.denyBrowser, "Missing setup request."],
      [op.denyDevice, "Missing setup request."],
      [op.previewDevice, "Missing device code."],
      [op.approveDevice, "Missing device code."]
    ]) {
      assert.equal(
        await missing.redirectOf(name, { ...fixture }),
        url(errorPage, {
          status: "400",
          code: "invalid_request",
          message,
          ...fixture
        })
      );
    }
    assert.deepEqual(missing.sessionInputs, []);

    const domainFailure = loadActions({
      domainResult: () => ({
        ok: false,
        error: {
          status: 409,
          code: "setup_request_not_pending",
          message: "Setup request is no longer pending."
        }
      })
    });
    const sessionFailure = loadActions({
      transaction: async () => ({
        ok: false,
        status: 401,
        code: "authentication_required",
        message: "Sign in again."
      })
    });
    for (const name of [op.approveBrowser, op.approveDevice, op.denyBrowser]) {
      const fields = { setupRequestId: "setup-1", userCode: "ABCD-EFGH" };
      assert.equal(
        await domainFailure.redirectOf(name, fields),
        url(errorPage, {
          status: "409",
          code: "setup_request_not_pending",
          message: "Setup request is no longer pending."
        })
      );
      assert.equal(
        await sessionFailure.redirectOf(name, fields),
        url(errorPage, {
          status: "401",
          code: "authentication_required",
          message: "Sign in again."
        })
      );
    }

    const thrown = loadActions({
      domainResult: () => new Error("raw approval failure")
    });
    for (const name of [op.approveBrowser, op.approveDevice, op.denyDevice]) {
      assert.equal(
        await thrown.redirectOf(name, {
          setupRequestId: "setup-1",
          userCode: "ABCD-EFGH",
          ...fixture
        }),
        url(errorPage, {
          status: "503",
          code: "temporary_unavailable",
          message: `Caller ${op.operation} approval is temporarily unavailable.`,
          ...fixture
        })
      );
    }
    assert.deepEqual(
      thrown.reports.map(
        ({ requestId, route, method, operation, session }) => ({
          requestId,
          route,
          method,
          operation,
          session
        })
      ),
      [
        ["approve_req", "approve", "browser_approval"],
        ["device_req", "device", "device_approval"],
        ["deny_req", "device", "deny"]
      ].map(([requestKind, page, operation]) => ({
        requestId: `caller_${op.operation}_${requestKind}_test`,
        route: `/caller/${op.operation}/${page}`,
        method: "POST",
        operation: `caller_${op.operation}_${operation}`,
        session: SESSION
      }))
    );

    const controlFlow = Object.assign(new Error("NEXT_REDIRECT"), {
      controlFlow: true
    });
    const signIn = loadActions({
      transaction: async () => {
        throw controlFlow;
      }
    });
    await assert.rejects(
      signIn.run(op.approveDevice, { userCode: "ABCD-EFGH" }),
      (error) => error === controlFlow
    );
    assert.deepEqual(signIn.reports, []);
  });
}
