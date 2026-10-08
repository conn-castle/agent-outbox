import Link from "next/link";

import type { ConnectApprovalPreviewData } from "../../../src/server/caller-connect";
import type { SetupTerminalStateData } from "../../../src/server/caller-setup-requests";
import type { HumanAccountSession } from "../../../src/server/human-session";
import {
  approveBrowserConnect,
  approveDeviceConnect,
  denyBrowserConnect,
  denyDeviceConnect
} from "../approval-actions";
import {
  ConnectionSummary,
  ConnectActions,
  ConnectFlowCard,
  ConnectPageShell,
  DecisionForm,
  OutcomeSummary
} from "./ui";

type ApprovalViewProps = {
  preview: ConnectApprovalPreviewData;
  session: HumanAccountSession;
  fixtureClerkUserId?: string | null;
  interactive?: boolean;
};

export function BrowserApprovalView({
  preview,
  session,
  fixtureClerkUserId,
  interactive = true
}: ApprovalViewProps) {
  return (
    <ConnectPageShell
      title={`Allow ${preview.display_name} to connect?`}
      description="Approving creates credentials for this caller on the account below."
    >
      <ConnectFlowCard label="Caller approval">
        <ConnectionSummary preview={preview} session={session} />
        <p className="connect-trust-note">
          Approve only if the app name above matches the CLI request you just
          started.
        </p>
        <ConnectActions>
          {interactive ? (
            <>
              <DecisionForm
                action={approveBrowserConnect}
                field="setupRequestId"
                value={preview.setup_request_id}
                fixtureClerkUserId={fixtureClerkUserId}
                pendingChildren="Approving…"
              >
                Approve connection
              </DecisionForm>
              <DecisionForm
                action={denyBrowserConnect}
                field="setupRequestId"
                value={preview.setup_request_id}
                fixtureClerkUserId={fixtureClerkUserId}
                secondary
                pendingChildren="Declining…"
              >
                Decline
              </DecisionForm>
            </>
          ) : (
            <>
              <button className="button" type="button">
                Approve connection
              </button>
              <button className="button secondary" type="button">
                Decline
              </button>
            </>
          )}
        </ConnectActions>
      </ConnectFlowCard>
    </ConnectPageShell>
  );
}

export function DeviceApprovalView({
  preview,
  session,
  fixtureClerkUserId,
  userCode,
  interactive = true
}: ApprovalViewProps & { userCode: string }) {
  return (
    <ConnectPageShell
      title="Does this code match?"
      description="Compare it with the code in the terminal where you started this connection."
      dense
    >
      <ConnectFlowCard label="Caller approval">
        <div className="connect-code-panel" aria-labelledby="device-approve">
          <span id="device-approve">Code shown in your terminal</span>
          <output
            className="device-code-hero"
            aria-label={`Device verification code: ${userCode}`}
          >
            {userCode}
          </output>
        </div>
        <ConnectionSummary preview={preview} session={session} />
        <p className="connect-trust-note">
          If the codes do not match, decline this request. No access will be
          granted.
        </p>
        <div className="connect-device-decision">
          <ConnectActions>
            {interactive ? (
              <>
                <DecisionForm
                  action={approveDeviceConnect}
                  field="userCode"
                  value={userCode}
                  fixtureClerkUserId={fixtureClerkUserId}
                  pendingChildren="Connecting…"
                >
                  Confirm and connect
                </DecisionForm>
                <DecisionForm
                  action={denyDeviceConnect}
                  field="setupRequestId"
                  value={preview.setup_request_id}
                  fixtureClerkUserId={fixtureClerkUserId}
                  secondary
                  pendingChildren="Declining…"
                >
                  Decline
                </DecisionForm>
              </>
            ) : (
              <>
                <button className="button" type="button">
                  Confirm and connect
                </button>
                <button className="button secondary" type="button">
                  Decline
                </button>
              </>
            )}
          </ConnectActions>
        </div>
      </ConnectFlowCard>
    </ConnectPageShell>
  );
}

export function ConnectionSuccessView({
  setup,
  session
}: {
  setup: SetupTerminalStateData;
  session: HumanAccountSession;
}) {
  const callerDisplayName = setup.caller?.display_name ?? setup.display_name;

  return (
    <ConnectPageShell
      title="You're connected"
      description="Connection approved. Return to your terminal to finish signing in."
      tone="success"
    >
      <ConnectFlowCard label="Approval success" tone="success">
        <div className="connect-handoff">
          <strong>Continue in your terminal</strong>
          <p>
            Your terminal will finish setting up this connection. You can safely
            close this tab.
          </p>
        </div>
        <OutcomeSummary callerName={callerDisplayName} session={session} />
        <Link className="connect-secondary-link" href="/human">
          Go to review queue instead
        </Link>
      </ConnectFlowCard>
    </ConnectPageShell>
  );
}

export function ConnectionDeclinedView({
  setup,
  session
}: {
  setup: SetupTerminalStateData;
  session: HumanAccountSession;
}) {
  const callerDisplayName = setup.caller?.display_name ?? setup.display_name;

  return (
    <ConnectPageShell
      title="Connection request declined"
      description="No access was granted and no caller credentials were created."
      tone="canceled"
    >
      <ConnectFlowCard label="Approval error" tone="error">
        <OutcomeSummary callerName={callerDisplayName} session={session} />
        <p className="connect-outcome-note">
          If this was a mistake, start a new connection from your terminal.
        </p>
        <ConnectActions>
          <Link className="button" href="/human">
            Back to review queue
          </Link>
        </ConnectActions>
      </ConnectFlowCard>
    </ConnectPageShell>
  );
}
