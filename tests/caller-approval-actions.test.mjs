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
  /** @type {string[]} */
  const domainCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const sessionInputs = [];
  /** @type {Array<Record<string, unknown>>} */
  const reports = [];

  /**
   * @param {(input: Record<string, unknown>) => unknown} success
   * @param {string} domainName
   */
  const domainFunction =
    (success, domainName) =>
    /**
     * @param {unknown} _query
     * @param {Record<string, unknown>} input
     */
    async (_query, input) => {
      // Copy out of the VM realm so deepStrictEqual compares plain objects.
      domainInputs.push({ ...input });
      domainCalls.push(domainName);
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
      approveConnectBrowserSetupRequest: domainFunction(
        browserApproval,
        "connect_browser"
      ),
      approveConnectDeviceSetupRequest: domainFunction(
        () => ({
          setup_request_id: "setup-device",
          caller: CALLER
        }),
        "connect_device"
      ),
      denyConnectSetupRequest: domainFunction(denied, "connect_deny")
    },
    "../../src/server/caller-credential-operations": {
      approveCredentialOperationBrowserSetupRequest: domainFunction(
        browserApproval,
        "credential_browser"
      ),
      approveCredentialOperationDeviceSetupRequest: domainFunction(
        (input) => ({
          setup_request_id: "setup-device",
          operation: input.operation,
          caller: CALLER
        }),
        "credential_device"
      ),
      denyCredentialOperationSetupRequest: domainFunction(
        denied,
        "credential_deny"
      )
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
   * @param {Record<string, string | Blob>} fields
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
   * @param {Record<string, string | Blob>} fields
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

  return { run, redirectOf, domainInputs, domainCalls, sessionInputs, reports };
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
    const { redirectOf, domainInputs, domainCalls, sessionInputs, reports } =
      loadActions();
    const fixtureFields = { [FIXTURE_PARAM]: " user_fixture " };

    assert.equal(
      await redirectOf(op.approveBrowser, {
        setupRequestId: " setup-1 ",
        ...fixtureFields
      }),
      url("http://127.0.0.1:4567/callback", {
        state: "local",
        status: "approved",
        setup_request_id: "setup-approved",
        setup_code: "code-123"
      })
    );
    assert.equal(
      await redirectOf(op.previewDevice, {
        userCode: " ABCD-EFGH ",
        ...fixtureFields
      }),
      url(`/caller/${op.operation}/device`, {
        user_code: "ABCD-EFGH",
        ...fixture
      })
    );
    assert.equal(sessionInputs.length, 1);
    assert.equal(domainInputs.length, 1);
    assert.equal(
      await redirectOf(op.approveDevice, {
        userCode: " ABCD-EFGH ",
        ...fixtureFields
      }),
      url(`/caller/${op.operation}/success`, {
        ...op.deviceSuccessParams,
        ...fixture
      })
    );
    for (const deny of [op.denyBrowser, op.denyDevice]) {
      assert.equal(
        await redirectOf(deny, {
          setupRequestId: " setup-1 ",
          ...fixtureFields
        }),
        url(errorPage, {
          status: "200",
          code: "setup_denied",
          message: op.deniedMessage,
          ...fixture,
          setup_request_id: "setup-denied"
        })
      );
    }

    const domain = op.operation === "connect" ? "connect" : "credential";
    assert.deepEqual(domainCalls, [
      `${domain}_browser`,
      `${domain}_device`,
      `${domain}_deny`,
      `${domain}_deny`
    ]);
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
    assert.deepEqual(reports, []);
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

  test(`${op.operation} validates required fields before session or domain work`, async () => {
    const subject = loadActions();
    for (const [name, field, message] of [
      [op.approveBrowser, "setupRequestId", "Missing setup request."],
      [op.denyBrowser, "setupRequestId", "Missing setup request."],
      [op.denyDevice, "setupRequestId", "Missing setup request."],
      [op.previewDevice, "userCode", "Missing device code."],
      [op.approveDevice, "userCode", "Missing device code."]
    ]) {
      for (const value of [undefined, " ", new Blob(["non-text"])]) {
        const fields =
          value === undefined ? fixture : { [field]: value, ...fixture };
        assert.equal(
          await subject.redirectOf(name, fields),
          url(errorPage, {
            status: "400",
            code: "invalid_request",
            message,
            ...fixture
          })
        );
      }
    }
    assert.deepEqual(subject.sessionInputs, []);
    assert.deepEqual(subject.domainInputs, []);
    assert.deepEqual(subject.reports, []);
  });
}

for (const op of OPERATIONS) {
  test(`${op.operation} all mutation entries retain error and framework-control-flow contracts`, async () => {
    const fields = {
      setupRequestId: " setup-1 ",
      userCode: " ABCD-EFGH ",
      [FIXTURE_PARAM]: " user_fixture "
    };
    const actions = [
      [op.approveBrowser, "approve", "approve", "browser_approval"],
      [op.approveDevice, "device", "device", "device_approval"],
      [op.denyBrowser, "deny", "approve", "deny"],
      [op.denyDevice, "deny", "device", "deny"]
    ];
    for (const [name, kind, page, operation] of actions) {
      for (const failureKind of [
        "session",
        "domain",
        "domainThrow",
        "transactionThrow",
        "domainControlFlow",
        "transactionControlFlow"
      ]) {
        const controlFlow = Object.assign(new Error("NEXT_REDIRECT"), {
          controlFlow: true
        });
        const unavailable = new Error("unavailable");
        const failure = {
          status: 409,
          code: "conflict",
          message: "Cannot approve."
        };
        const sessionFailure = {
          status: 401,
          code: "authentication_required",
          message: "Sign in again."
        };
        const behavior =
          failureKind === "session"
            ? { transaction: async () => ({ ok: false, ...sessionFailure }) }
            : failureKind === "domain"
              ? { domainResult: () => ({ ok: false, error: failure }) }
              : failureKind === "domainThrow"
                ? { domainResult: () => unavailable }
                : failureKind === "transactionThrow"
                  ? {
                      transaction: async () => {
                        throw unavailable;
                      }
                    }
                  : failureKind === "domainControlFlow"
                    ? { domainResult: () => controlFlow }
                    : {
                        transaction: async () => {
                          throw controlFlow;
                        }
                      };
        const subject = loadActions(behavior);
        if (failureKind.endsWith("ControlFlow")) {
          await assert.rejects(
            subject.run(name, fields),
            (error) => error === controlFlow
          );
          assert.deepEqual(subject.reports, []);
          continue;
        }
        const expected =
          failureKind === "session"
            ? sessionFailure
            : failureKind === "domain"
              ? failure
              : {
                  status: 503,
                  code: "temporary_unavailable",
                  message: `Caller ${op.operation} approval is temporarily unavailable.`
                };
        assert.equal(
          await subject.redirectOf(name, fields),
          url(`/caller/${op.operation}/error`, {
            status: String(expected.status),
            code: expected.code,
            message: expected.message,
            [FIXTURE_PARAM]: "user_fixture"
          })
        );
        if (!failureKind.endsWith("Throw"))
          assert.deepEqual(subject.reports, []);
        else {
          assert.equal(subject.reports.length, 1);
          const { startedAtMs, ...report } = subject.reports[0];
          assert.equal(typeof startedAtMs, "number");
          assert.deepEqual(report, {
            requestId: `caller_${op.operation}_${kind}_req_test`,
            route: `/caller/${op.operation}/${page}`,
            operation: `caller_${op.operation}_${operation}`,
            method: "POST",
            session: failureKind === "domainThrow" ? SESSION : undefined
          });
        }
      }
    }
  });

  test(`${op.operation} field and URL contracts retain fixture normalization and query ordering`, async () => {
    const subject = loadActions();
    const fixture = { [FIXTURE_PARAM]: " user_fixture " };
    for (const name of [op.previewDevice, op.approveDevice]) {
      const params =
        name === op.previewDevice
          ? { user_code: "ABCD-EFGH" }
          : op.deviceSuccessParams;
      assert.equal(
        await subject.redirectOf(name, { userCode: " ABCD-EFGH ", ...fixture }),
        url(
          `/caller/${op.operation}/${name === op.previewDevice ? "device" : "success"}`,
          { ...params, [FIXTURE_PARAM]: "user_fixture" }
        )
      );
    }
    const emptyFixture = loadActions();
    assert.equal(
      await emptyFixture.redirectOf(op.previewDevice, {
        userCode: "ABCD-EFGH",
        [FIXTURE_PARAM]: " "
      }),
      url(`/caller/${op.operation}/device`, { user_code: "ABCD-EFGH" })
    );
    for (const fixtureValue of [" ", new Blob(["user_fixture"])]) {
      const noFixture = loadActions();
      assert.equal(
        await noFixture.redirectOf(op.approveDevice, {
          userCode: "ABCD-EFGH",
          [FIXTURE_PARAM]: fixtureValue
        }),
        url(`/caller/${op.operation}/success`, op.deviceSuccessParams)
      );
      assert.equal(noFixture.sessionInputs[0].fixtureClerkUserId, "");
    }
    const existingParams = loadActions({
      domainResult: () => ({
        ok: true,
        data: {
          setup_request_id: "request +?",
          setup_code: "code +?",
          caller: CALLER,
          callback_url:
            "http://127.0.0.1:4567/callback?setup_code=old&state=local&status=old"
        }
      })
    });
    assert.equal(
      await existingParams.redirectOf(op.approveBrowser, {
        setupRequestId: "setup-1",
        ...fixture
      }),
      url("http://127.0.0.1:4567/callback", {
        setup_code: "code +?",
        state: "local",
        status: "approved",
        setup_request_id: "request +?"
      })
    );
  });
}
