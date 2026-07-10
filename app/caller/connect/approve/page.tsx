import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectBrowserApprovalPreview } from "../../../../src/server/caller-connect";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../../../src/server/caller-connect-clerk-fixture";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import type { HumanAccountSession } from "../../../../src/server/human-session";
import { approveBrowserConnect, denyBrowserConnect } from "../actions";
import {
  firstParam,
  fixtureClerkUserIdParam,
  reportCallerApprovalFailure,
  requiredCallerConnectSessionConfiguration,
  runCallerConnectHumanTransaction
} from "../session";
import {
  AccountSummary,
  ApprovalSummary,
  ConnectActions,
  ConnectErrorPanel,
  ConnectPageShell
} from "../ui";

export const dynamic = "force-dynamic";

export default async function CallerConnectApprovePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const setupRequestId = firstParam(params?.setup_request_id);
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);

  if (!setupRequestId) {
    return (
      <ConnectPageShell eyebrow="Caller connect" title="Approve caller setup">
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
        title="Caller connect route is not configured"
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId("caller_connect_approve_page_req");
  let session: HumanAccountSession | undefined;
  let preview: Awaited<ReturnType<typeof getConnectBrowserApprovalPreview>>;
  const previewStartedAtMs = Date.now();
  try {
    const transaction = await runCallerConnectHumanTransaction(
      {
        requestId,
        fixtureClerkUserId,
        route: "/caller/connect/approve",
        method: "GET"
      },
      (query, humanSession) => {
        session = humanSession;
        return getConnectBrowserApprovalPreview(query, { setupRequestId });
      }
    );
    if (!transaction.ok) {
      return (
        <ConnectPageShell eyebrow="Caller connect" title="Approve caller setup">
          <ConnectErrorPanel error={transaction} />
        </ConnectPageShell>
      );
    }
    session = transaction.session;
    preview = transaction.data;
  } catch (error) {
    reportCallerApprovalFailure(error, {
      requestId,
      route: "/caller/connect/approve",
      method: "GET",
      operation: "caller_connect_browser_approval_preview",
      session,
      startedAtMs: previewStartedAtMs
    });
    preview = {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Caller connect approval is temporarily unavailable."
      }
    };
  }

  if (!session) {
    throw new Error("Human session is required after caller approval setup.");
  }

  return (
    <ConnectPageShell eyebrow="Caller connect" title="Approve caller setup">
      <AccountSummary session={session} />
      {preview.ok ? (
        <>
          <ApprovalSummary preview={preview.data} />
          <section className="connect-card" aria-label="Approval decision">
            <p>
              Approving sends a one-time setup code to the CLI callback URL.
            </p>
            <ConnectActions>
              <form action={approveBrowserConnect}>
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
                  Approve caller
                </button>
              </form>
              <form action={denyBrowserConnect}>
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
                  Cancel setup
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
