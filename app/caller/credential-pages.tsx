import Link from "next/link";

import {
  getCredentialOperationBrowserApprovalPreview,
  getCredentialOperationDeviceApprovalPreview,
  getCredentialOperationTerminalSetupState
} from "../../src/server/caller-credential-operations";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../src/server/caller-connect-clerk-fixture";
import { createCorrelationId } from "../../src/server/correlation";
import type { HumanAccountSession } from "../../src/server/human-session";
import { MissingConfigurationPanel } from "../../src/server/ui";
import {
  firstParam,
  fixtureClerkUserIdParam,
  reportCallerApprovalFailure,
  requiredCallerConnectSessionConfiguration,
  resolveCallerConnectHumanSession,
  runCallerConnectHumanTransaction
} from "./connect/session";
import {
  AccountSummary,
  ApprovalSummary,
  ConnectActions,
  ConnectErrorPanel,
  ConnectPageShell
} from "./connect/ui";

type CredentialOperation = "rotate" | "revoke";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type FormAction = (formData: FormData) => void | Promise<void>;
type TerminalStatusSelection = readonly [
  "approved" | "exchanged" | "denied",
  ...("approved" | "exchanged" | "denied")[]
];

export async function CredentialOperationApprovePage({
  operation,
  searchParams,
  approveAction,
  denyAction
}: {
  operation: CredentialOperation;
  searchParams?: SearchParams;
  approveAction: FormAction;
  denyAction: FormAction;
}) {
  const params = await searchParams;
  const setupRequestId = firstParam(params?.setup_request_id);
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);
  const label = operationLabel(operation);

  if (!setupRequestId) {
    return (
      <ConnectPageShell eyebrow={label} title={approvalTitle(operation)}>
        <ConnectErrorPanel
          error={{
            status: 400,
            code: "invalid_request",
            message: "Missing setup request."
          }}
        />
      </ConnectPageShell>
    );
  }

  const missing = requiredCallerConnectSessionConfiguration();
  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title={`${label} route is not configured`}
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId(`caller_${operation}_approve_page_req`);
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: `/caller/${operation}/approve`,
    method: "GET"
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow={label} title={approvalTitle(operation)}>
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }

  let preview: Awaited<
    ReturnType<typeof getCredentialOperationBrowserApprovalPreview>
  >;
  const previewStartedAtMs = Date.now();
  try {
    preview = await runCallerConnectHumanTransaction(
      session,
      requestId,
      (query) =>
        getCredentialOperationBrowserApprovalPreview(query, {
          operation,
          setupRequestId,
          accountId: session.accountId
        })
    );
  } catch (error) {
    reportCallerApprovalFailure(error, {
      requestId,
      route: `/caller/${operation}/approve`,
      method: "GET",
      operation: `caller_${operation}_browser_approval_preview`,
      session,
      startedAtMs: previewStartedAtMs
    });
    preview = temporaryPageError(operation, "approval");
  }

  return (
    <ConnectPageShell eyebrow={label} title={approvalTitle(operation)}>
      <AccountSummary session={session} />
      {preview.ok ? (
        <>
          <ApprovalSummary preview={preview.data} />
          <section className="connect-card" aria-label="Approval decision">
            <p>
              {operation === "rotate"
                ? "Approving lets the CLI exchange a setup code for a pending replacement key."
                : "Approving lets the CLI exchange a setup code to revoke hosted keys for this caller."}
            </p>
            <ConnectActions>
              <form action={approveAction}>
                <input
                  type="hidden"
                  name="setupRequestId"
                  value={preview.data.setup_request_id}
                />
                {fixtureClerkUserId ? (
                  <input
                    type="hidden"
                    name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
                    value={fixtureClerkUserId}
                  />
                ) : null}
                <button className="button" type="submit">
                  {approveButton(operation)}
                </button>
              </form>
              <form action={denyAction}>
                <input
                  type="hidden"
                  name="setupRequestId"
                  value={preview.data.setup_request_id}
                />
                {fixtureClerkUserId ? (
                  <input
                    type="hidden"
                    name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
                    value={fixtureClerkUserId}
                  />
                ) : null}
                <button className="button secondary" type="submit">
                  Cancel
                </button>
              </form>
            </ConnectActions>
          </section>
        </>
      ) : (
        <ConnectErrorPanel error={preview.error} />
      )}
    </ConnectPageShell>
  );
}

export async function CredentialOperationDevicePage({
  operation,
  searchParams,
  previewAction,
  approveAction,
  denyAction
}: {
  operation: CredentialOperation;
  searchParams?: SearchParams;
  previewAction: FormAction;
  approveAction: FormAction;
  denyAction: FormAction;
}) {
  const params = await searchParams;
  const userCode = firstParam(params?.user_code) ?? "";
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);
  const label = operationLabel(operation);

  if (!userCode) {
    return (
      <ConnectPageShell eyebrow={label} title="Verify device code">
        <section className="connect-card" aria-labelledby="device-code-heading">
          <h2 id="device-code-heading">Enter the CLI code</h2>
          <form
            id={`enter-${operation}-device-code`}
            action={previewAction}
            className="form-stack"
          >
            <label className="field">
              <span>User code</span>
              <input
                name="userCode"
                autoComplete="one-time-code"
                inputMode="text"
                placeholder="ABCD-EFGH"
                required
              />
            </label>
            {fixtureClerkUserId ? (
              <input
                type="hidden"
                name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
                value={fixtureClerkUserId}
              />
            ) : null}
          </form>
          <ConnectActions>
            <button
              className="button"
              form={`enter-${operation}-device-code`}
              type="submit"
            >
              Continue
            </button>
          </ConnectActions>
        </section>
      </ConnectPageShell>
    );
  }

  const missing = requiredCallerConnectSessionConfiguration();
  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title={`${label} route is not configured`}
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId(`caller_${operation}_device_page_req`);
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: `/caller/${operation}/device`,
    method: "GET"
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow={label} title="Verify device code">
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }

  let preview: Awaited<
    ReturnType<typeof getCredentialOperationDeviceApprovalPreview>
  >;
  const previewStartedAtMs = Date.now();
  try {
    preview = await runCallerConnectHumanTransaction(
      session,
      requestId,
      (query) =>
        getCredentialOperationDeviceApprovalPreview(query, {
          operation,
          userCode,
          accountId: session.accountId
        })
    );
  } catch (error) {
    reportCallerApprovalFailure(error, {
      requestId,
      route: `/caller/${operation}/device`,
      method: "GET",
      operation: `caller_${operation}_device_approval_preview`,
      session,
      startedAtMs: previewStartedAtMs
    });
    preview = temporaryPageError(operation, "approval");
  }

  return (
    <ConnectPageShell eyebrow={label} title="Verify device code">
      <AccountSummary session={session} />
      {preview.ok ? (
        <>
          <ApprovalSummary preview={preview.data} />
          <section className="connect-card" aria-labelledby="device-approve">
            <h2 id="device-approve">{approvalTitle(operation)}</h2>
            <form
              id={`approve-device-${operation}`}
              action={approveAction}
              className="form-stack"
            >
              <label className="field">
                <span>User code</span>
                <input
                  name="userCode"
                  autoComplete="one-time-code"
                  inputMode="text"
                  placeholder="ABCD-EFGH"
                  defaultValue={userCode}
                  readOnly
                  required
                />
              </label>
              {fixtureClerkUserId ? (
                <input
                  type="hidden"
                  name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
                  value={fixtureClerkUserId}
                />
              ) : null}
            </form>
            <form id={`deny-device-${operation}`} action={denyAction}>
              <input
                type="hidden"
                name="setupRequestId"
                value={preview.data.setup_request_id}
              />
              {fixtureClerkUserId ? (
                <input
                  type="hidden"
                  name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
                  value={fixtureClerkUserId}
                />
              ) : null}
            </form>
            <ConnectActions>
              <button
                className="button"
                form={`approve-device-${operation}`}
                type="submit"
              >
                {approveButton(operation)}
              </button>
              <button
                className="button secondary"
                form={`deny-device-${operation}`}
                type="submit"
              >
                Cancel
              </button>
            </ConnectActions>
          </section>
        </>
      ) : (
        <ConnectErrorPanel error={preview.error} />
      )}
    </ConnectPageShell>
  );
}

export async function CredentialOperationSuccessPage({
  operation,
  searchParams
}: {
  operation: CredentialOperation;
  searchParams?: SearchParams;
}) {
  const params = await searchParams;
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);
  const setupRequestId = firstParam(params?.setup_request_id);
  const label = operationLabel(operation);
  const missing = requiredCallerConnectSessionConfiguration();

  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title={`${label} route is not configured`}
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId(`caller_${operation}_success_page_req`);
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: `/caller/${operation}/success`,
    method: "GET"
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow={label} title={successTitle(operation)}>
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }
  if (!setupRequestId) {
    return (
      <ConnectPageShell eyebrow={label} title={successTitle(operation)}>
        <ConnectErrorPanel
          error={{
            status: 400,
            code: "invalid_request",
            message: "Missing setup request."
          }}
        />
      </ConnectPageShell>
    );
  }

  const setupState = await terminalSetupState(
    operation,
    session,
    requestId,
    setupRequestId,
    ["approved", "exchanged"],
    {
      route: `/caller/${operation}/success`,
      method: "GET",
      operation: `caller_${operation}_terminal_success`
    }
  );
  if (!setupState.ok) {
    return (
      <ConnectPageShell eyebrow={label} title={successTitle(operation)}>
        <ConnectErrorPanel error={setupState.error} />
      </ConnectPageShell>
    );
  }

  const setup = setupState.data;
  const callerDisplayName = setup.caller?.display_name ?? setup.display_name;

  return (
    <ConnectPageShell eyebrow={label} title={successTitle(operation)}>
      <AccountSummary session={session} />
      <section className="connect-card" aria-label="Approval success">
        <p>
          {operation === "rotate"
            ? "The device code was approved. Return to the CLI to exchange and activate the replacement key."
            : "The device code was approved. Return to the CLI to confirm revocation."}
        </p>
        <dl className="connect-kv">
          <div>
            <dt>Caller</dt>
            <dd>{callerDisplayName}</dd>
          </div>
          <div>
            <dt>Setup request</dt>
            <dd>
              <code>{setup.setup_request_id}</code>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <code>{setup.status}</code>
            </dd>
          </div>
        </dl>
        <ConnectActions>
          <Link className="button secondary" href="/human">
            Open review queue
          </Link>
        </ConnectActions>
      </section>
    </ConnectPageShell>
  );
}

export async function CredentialOperationErrorPage({
  operation,
  searchParams
}: {
  operation: CredentialOperation;
  searchParams?: SearchParams;
}) {
  const params = await searchParams;
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);
  const status = firstParam(params?.status) ?? "400";
  const code = firstParam(params?.code) ?? "invalid_request";
  const message =
    firstParam(params?.message) ??
    `Caller ${operation} approval could not continue.`;
  const setupRequestId = firstParam(params?.setup_request_id);
  const label = operationLabel(operation);
  const missing = requiredCallerConnectSessionConfiguration();

  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title={`${label} route is not configured`}
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId(`caller_${operation}_error_page_req`);
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: `/caller/${operation}/error`,
    method: "GET"
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow={label} title={errorTitle(operation)}>
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }
  if (code === "setup_denied" && setupRequestId) {
    const setupState = await terminalSetupState(
      operation,
      session,
      requestId,
      setupRequestId,
      ["denied"],
      {
        route: `/caller/${operation}/error`,
        method: "GET",
        operation: `caller_${operation}_terminal_denied`
      }
    );
    if (setupState.ok) {
      const setup = setupState.data;
      const callerDisplayName =
        setup.caller?.display_name ?? setup.display_name;

      return (
        <ConnectPageShell eyebrow={label} title={errorTitle(operation)}>
          <AccountSummary session={session} />
          <section className="connect-card" aria-label="Approval error">
            <dl className="connect-kv">
              <div>
                <dt>Status</dt>
                <dd>
                  <code>{setup.status}</code>
                </dd>
              </div>
              <div>
                <dt>Code</dt>
                <dd>
                  <code>setup_denied</code>
                </dd>
              </div>
              <div>
                <dt>Caller</dt>
                <dd>{callerDisplayName}</dd>
              </div>
              <div>
                <dt>Setup request</dt>
                <dd>
                  <code>{setup.setup_request_id}</code>
                </dd>
              </div>
            </dl>
            <p>{`Caller ${operation} was canceled.`}</p>
            <ConnectActions>
              <Link
                className="button secondary"
                href={`/caller/${operation}/device`}
              >
                Enter device code
              </Link>
            </ConnectActions>
          </section>
        </ConnectPageShell>
      );
    }

    return (
      <ConnectPageShell eyebrow={label} title={errorTitle(operation)}>
        <ConnectErrorPanel error={setupState.error} />
      </ConnectPageShell>
    );
  }

  return (
    <ConnectPageShell eyebrow={label} title={errorTitle(operation)}>
      <ConnectErrorPanel
        error={{
          status,
          code,
          message
        }}
      />
    </ConnectPageShell>
  );
}

async function terminalSetupState(
  operation: CredentialOperation,
  session: HumanAccountSession,
  requestId: string,
  setupRequestId: string,
  statuses: TerminalStatusSelection,
  reportContext: {
    route: string;
    method: string;
    operation: string;
  }
): Promise<
  Awaited<ReturnType<typeof getCredentialOperationTerminalSetupState>>
> {
  const startedAtMs = Date.now();
  try {
    return await runCallerConnectHumanTransaction(session, requestId, (query) =>
      getCredentialOperationTerminalSetupState(query, {
        operation,
        setupRequestId,
        accountId: session.accountId,
        statuses
      })
    );
  } catch (error) {
    reportCallerApprovalFailure(error, {
      requestId,
      session,
      ...reportContext,
      startedAtMs
    });
    return temporaryPageError(operation, "status");
  }
}

function temporaryPageError(
  operation: CredentialOperation,
  noun: string
): {
  ok: false;
  error: {
    status: 503;
    code: "temporary_unavailable";
    message: string;
  };
} {
  return {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message: `Caller ${operation} ${noun} is temporarily unavailable.`
    }
  };
}

function operationLabel(operation: CredentialOperation) {
  return operation === "rotate" ? "Caller rotate" : "Caller revoke";
}

function approvalTitle(operation: CredentialOperation) {
  return operation === "rotate"
    ? "Approve key rotation"
    : "Approve caller revoke";
}

function approveButton(operation: CredentialOperation) {
  return operation === "rotate" ? "Approve rotation" : "Approve revoke";
}

function successTitle(operation: CredentialOperation) {
  return operation === "rotate" ? "Rotation approved" : "Revoke approved";
}

function errorTitle(operation: CredentialOperation) {
  return operation === "rotate" ? "Rotation failed" : "Revoke failed";
}
