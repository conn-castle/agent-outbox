import Link from "next/link";
import { unstable_rethrow } from "next/navigation";

import { ActionSubmitButton } from "../../src/components/actions/ActionSubmitButton";
import {
  getCredentialOperationBrowserApprovalPreview,
  getCredentialOperationDeviceApprovalPreview,
  getCredentialOperationTerminalSetupState
} from "../../src/server/caller-credential-operations";
import { createCorrelationId } from "../../src/server/correlation";
import type { ProductTransactionQuery } from "../../src/server/database";
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
  ConnectErrorPage,
  ConnectErrorPanel,
  ConnectPageShell,
  DeviceCodeEntryCard,
  FixtureIdentity,
  type FormAction,
  MISSING_SETUP_REQUEST_ERROR
} from "./connect/ui";

type CredentialOperation = "rotate" | "revoke";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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
      <ConnectErrorPage
        title={approvalTitle(operation)}
        error={MISSING_SETUP_REQUEST_ERROR}
      />
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
  const page = await credentialPageTransaction(
    operation,
    fixtureClerkUserId,
    {
      requestId,
      route: `/caller/${operation}/approve`,
      method: "GET",
      operation: `caller_${operation}_browser_approval_preview`
    },
    "approval",
    (query, session) =>
      getCredentialOperationBrowserApprovalPreview(query, {
        operation,
        setupRequestId,
        accountId: session.accountId
      })
  );
  if (!page.ok) {
    return (
      <ConnectErrorPage title={approvalTitle(operation)} error={page.error} />
    );
  }
  const { session, data: preview } = page;

  return (
    <ConnectPageShell title={approvalTitle(operation)}>
      <AccountSummary session={session} />
      {preview.ok ? (
        <>
          <ApprovalSummary preview={preview.data} showCredentialDetails />
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
                <FixtureIdentity value={fixtureClerkUserId} />
                <ActionSubmitButton
                  className="button"
                  pendingChildren="Approving…"
                >
                  {approveButton(operation)}
                </ActionSubmitButton>
              </form>
              <form action={denyAction}>
                <input
                  type="hidden"
                  name="setupRequestId"
                  value={preview.data.setup_request_id}
                />
                <FixtureIdentity value={fixtureClerkUserId} />
                <ActionSubmitButton
                  className="button secondary"
                  pendingChildren="Cancelling…"
                >
                  Cancel
                </ActionSubmitButton>
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
      <ConnectPageShell title="Verify device code">
        <DeviceCodeEntryCard
          formId={`enter-${operation}-device-code`}
          action={previewAction}
          fixtureClerkUserId={fixtureClerkUserId}
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

  const requestId = createCorrelationId(`caller_${operation}_device_page_req`);
  const page = await credentialPageTransaction(
    operation,
    fixtureClerkUserId,
    {
      requestId,
      route: `/caller/${operation}/device`,
      method: "GET",
      operation: `caller_${operation}_device_approval_preview`
    },
    "approval",
    (query, session) =>
      getCredentialOperationDeviceApprovalPreview(query, {
        operation,
        userCode,
        accountId: session.accountId
      })
  );
  if (!page.ok) {
    return <ConnectErrorPage title="Verify device code" error={page.error} />;
  }
  const { session, data: preview } = page;

  return (
    <ConnectPageShell title="Verify device code">
      <AccountSummary session={session} />
      {preview.ok ? (
        <>
          <ApprovalSummary preview={preview.data} showCredentialDetails />
          <section className="connect-card" aria-labelledby="device-approve">
            <h2 id="device-approve">{approvalTitle(operation)}</h2>
            <ConnectActions>
              <form action={approveAction} className="form-stack">
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
                <FixtureIdentity value={fixtureClerkUserId} />
                <ActionSubmitButton
                  className="button"
                  pendingChildren="Approving…"
                >
                  {approveButton(operation)}
                </ActionSubmitButton>
              </form>
              <form action={denyAction}>
                <input
                  type="hidden"
                  name="setupRequestId"
                  value={preview.data.setup_request_id}
                />
                <FixtureIdentity value={fixtureClerkUserId} />
                <ActionSubmitButton
                  className="button secondary"
                  pendingChildren="Cancelling…"
                >
                  Cancel
                </ActionSubmitButton>
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
  if (!setupRequestId) {
    const session = await resolveCallerConnectHumanSession({
      requestId,
      fixtureClerkUserId,
      route: `/caller/${operation}/success`,
      method: "GET"
    });
    if (!session.ok) {
      return (
        <ConnectErrorPage title={successTitle(operation)} error={session} />
      );
    }
    return (
      <ConnectErrorPage
        title={successTitle(operation)}
        error={MISSING_SETUP_REQUEST_ERROR}
      />
    );
  }

  const page = await credentialPageTransaction(
    operation,
    fixtureClerkUserId,
    {
      requestId,
      route: `/caller/${operation}/success`,
      method: "GET",
      operation: `caller_${operation}_terminal_success`
    },
    "status",
    (query, session) =>
      getCredentialOperationTerminalSetupState(query, {
        operation,
        setupRequestId,
        accountId: session.accountId,
        statuses: ["approved", "exchanged"]
      })
  );
  if (!page.ok) {
    return (
      <ConnectErrorPage title={successTitle(operation)} error={page.error} />
    );
  }
  const { session, data: setupState } = page;
  if (!setupState.ok) {
    return (
      <ConnectErrorPage
        title={successTitle(operation)}
        error={setupState.error}
      />
    );
  }

  const setup = setupState.data;
  const callerDisplayName = setup.caller?.display_name ?? setup.display_name;

  return (
    <ConnectPageShell title={successTitle(operation)}>
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
  if (code === "setup_denied" && setupRequestId) {
    const page = await credentialPageTransaction(
      operation,
      fixtureClerkUserId,
      {
        requestId,
        route: `/caller/${operation}/error`,
        method: "GET",
        operation: `caller_${operation}_terminal_denied`
      },
      "status",
      (query, session) =>
        getCredentialOperationTerminalSetupState(query, {
          operation,
          setupRequestId,
          accountId: session.accountId,
          statuses: ["denied"]
        })
    );
    if (!page.ok) {
      return (
        <ConnectErrorPage title={errorTitle(operation)} error={page.error} />
      );
    }
    const { session, data: setupState } = page;
    if (setupState.ok) {
      const setup = setupState.data;
      const callerDisplayName =
        setup.caller?.display_name ?? setup.display_name;

      return (
        <ConnectPageShell title={errorTitle(operation)}>
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
      <ConnectErrorPage
        title={errorTitle(operation)}
        error={setupState.error}
      />
    );
  }

  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: `/caller/${operation}/error`,
    method: "GET"
  });
  if (!session.ok) {
    return <ConnectErrorPage title={errorTitle(operation)} error={session} />;
  }

  return (
    <ConnectErrorPage
      title={errorTitle(operation)}
      error={{ status, code, message }}
    />
  );
}

async function credentialPageTransaction<TResult>(
  operation: CredentialOperation,
  fixtureClerkUserId: string | undefined,
  reportContext: {
    requestId: string;
    route: string;
    method: string;
    operation: string;
  },
  errorNoun: string,
  callback: (
    query: ProductTransactionQuery,
    session: HumanAccountSession
  ) => Promise<TResult>
): Promise<
  | { ok: true; session: HumanAccountSession; data: TResult }
  | { ok: false; error: { status: number; code: string; message: string } }
> {
  const startedAtMs = Date.now();
  let activeSession: HumanAccountSession | undefined;
  try {
    const transaction = await runCallerConnectHumanTransaction(
      {
        requestId: reportContext.requestId,
        fixtureClerkUserId,
        route: reportContext.route,
        method: reportContext.method
      },
      (query, session) => {
        activeSession = session;
        return callback(query, session);
      }
    );
    if (!transaction.ok) {
      return { ok: false, error: transaction };
    }
    return {
      ok: true,
      session: transaction.session,
      data: transaction.data
    };
  } catch (error) {
    unstable_rethrow(error);
    reportCallerApprovalFailure(error, {
      session: activeSession,
      ...reportContext,
      startedAtMs
    });
    return temporaryPageError(operation, errorNoun);
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
