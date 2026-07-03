import Link from "next/link";

import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectTerminalSetupState } from "../../../../src/server/caller-connect";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import {
  firstParam,
  fixtureClerkUserIdParam,
  requiredCallerConnectSessionConfiguration,
  resolveCallerConnectHumanSession,
  runCallerConnectHumanTransaction
} from "../session";
import {
  AccountSummary,
  ConnectActions,
  ConnectErrorPanel,
  ConnectPageShell
} from "../ui";

export const dynamic = "force-dynamic";

export default async function CallerConnectSuccessPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);
  const setupRequestId = firstParam(params?.setup_request_id);
  const missing = requiredCallerConnectSessionConfiguration();

  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title="Caller connect route is not configured"
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId("caller_connect_success_page_req");
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow="Caller connect" title="Caller approved">
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }
  if (!setupRequestId) {
    return (
      <ConnectPageShell eyebrow="Caller connect" title="Caller approved">
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

  let setupState: Awaited<ReturnType<typeof getConnectTerminalSetupState>>;
  try {
    setupState = await runCallerConnectHumanTransaction(
      session,
      requestId,
      (query) =>
        getConnectTerminalSetupState(query, {
          setupRequestId,
          accountId: session.accountId,
          statuses: ["approved", "exchanged"]
        })
    );
  } catch {
    setupState = {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Caller connect success is temporarily unavailable."
      }
    };
  }

  if (!setupState.ok) {
    return (
      <ConnectPageShell eyebrow="Caller connect" title="Caller approved">
        <ConnectErrorPanel error={setupState.error} />
      </ConnectPageShell>
    );
  }

  const setup = setupState.data;
  const callerDisplayName = setup.caller?.display_name ?? setup.display_name;

  return (
    <ConnectPageShell eyebrow="Caller connect" title="Caller approved">
      <AccountSummary session={session} />
      <section className="connect-card" aria-label="Approval success">
        <p>
          {setup.flow === "device"
            ? "The device code was approved. Return to the CLI to finish setup."
            : "The caller setup request was approved."}
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
