import { notFound } from "next/navigation";

import { StoryboardShell } from "../../../../src/components/StoryboardShell";
import type { ConnectApprovalPreviewData } from "../../../../src/server/caller-connect";
import type { SetupTerminalStateData } from "../../../../src/server/caller-setup-requests";
import { humanBrowserFixtureEnabled } from "../../../../src/server/human-review-fixture-gate";
import type { HumanAccountSession } from "../../../../src/server/human-session";
import { firstSearchParam } from "../../../../src/shared/human-review-view";
import {
  BrowserApprovalView,
  ConnectionDeclinedView,
  ConnectionSuccessView,
  DeviceApprovalView
} from "../views";

export const dynamic = "force-dynamic";

const scenarios = [
  {
    key: "browser",
    label: "Browser approval",
    title: "Allow a caller connection",
    coverage: ["pending", "browser flow", "approval decision"]
  },
  {
    key: "device",
    label: "Device approval",
    title: "Verify a terminal code",
    coverage: ["pending", "device flow", "code comparison"]
  },
  {
    key: "success",
    label: "Connection success",
    title: "Return to the terminal",
    coverage: ["approved", "handoff", "completion"]
  },
  {
    key: "declined",
    label: "Connection declined",
    title: "Confirm no access was granted",
    coverage: ["denied", "safe outcome", "recovery"]
  }
] as const;

type ScenarioKey = (typeof scenarios)[number]["key"];

const session: HumanAccountSession = {
  surface: "human",
  accountId: "storyboard-account",
  userId: "storyboard-user",
  role: "owner",
  account: {
    accountId: "storyboard-account",
    label: "Your Agent Outbox account",
    tier: "free",
    billingStatus: "active",
    billingGraceEndsAt: null
  },
  provisionedAccount: false
};

function selectedScenario(value: string | undefined) {
  return scenarios.find((scenario) => scenario.key === value) ?? scenarios[0];
}

export default async function CallerConnectStoryboardPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!humanBrowserFixtureEnabled()) notFound();

  const params = await searchParams;
  const selected = selectedScenario(firstSearchParam(params?.scenario));
  if (firstSearchParam(params?.mode) === "preview") {
    return <ScenarioPreview scenario={selected.key} />;
  }

  return (
    <StoryboardShell
      label="Caller connect storyboard"
      previewHref={scenarioHref(selected.key, true)}
      indexLabel="Caller connect scenarios"
      countLabel={`${scenarios.length} connection scenarios`}
      intro="Choose a state, then inspect the real shared UI at each exact width."
      scenarios={scenarios.map((scenario) => ({
        key: scenario.key,
        href: scenarioHref(scenario.key),
        label: scenario.label,
        selected: scenario.key === selected.key
      }))}
      eyebrow={selected.label}
      title={selected.title}
      subtitle="Real caller-connect view · deterministic fixture state"
      coverage={selected.coverage}
    />
  );
}

function ScenarioPreview({ scenario }: { scenario: ScenarioKey }) {
  const preview: ConnectApprovalPreviewData = {
    setup_request_id: `storyboard-${scenario}-request`,
    operation: "connect",
    flow: scenario === "browser" ? "browser" : "device",
    status: "pending",
    local_caller_name: "agent-outbox-cli",
    display_name: "Agent Outbox CLI",
    callback_url:
      scenario === "browser"
        ? "http://127.0.0.1:39010/caller/connect/callback"
        : null,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
  };

  if (scenario === "browser") {
    return (
      <BrowserApprovalView
        preview={preview}
        session={session}
        interactive={false}
      />
    );
  }
  if (scenario === "device") {
    return (
      <DeviceApprovalView
        preview={preview}
        session={session}
        userCode="LBYD-4KDL"
        interactive={false}
      />
    );
  }

  const setup: SetupTerminalStateData = {
    setup_request_id: `storyboard-${scenario}-request`,
    operation: "connect",
    flow: "device",
    status: scenario === "success" ? "approved" : "denied",
    local_caller_name: "agent-outbox-cli",
    display_name: "Agent Outbox CLI",
    caller: {
      caller_id: "storyboard-caller",
      caller_slug: "agent-outbox-cli",
      display_name: "Agent Outbox CLI"
    }
  };

  return scenario === "success" ? (
    <ConnectionSuccessView setup={setup} session={session} />
  ) : (
    <ConnectionDeclinedView setup={setup} session={session} />
  );
}

function scenarioHref(scenario: ScenarioKey, preview = false) {
  const params = new URLSearchParams({ scenario });
  if (preview) params.set("mode", "preview");
  return `/caller/connect/storyboard?${params.toString()}`;
}
