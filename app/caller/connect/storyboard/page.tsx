import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import type {
  ConnectApprovalPreviewData,
  ConnectTerminalSetupData
} from "../../../../src/server/caller-connect";
import { humanBrowserFixtureEnabled } from "../../../../src/server/human-review-fixture-gate";
import type { HumanAccountSession } from "../../../../src/server/human-session";
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

const viewports = [
  {
    key: "desktop",
    label: "Desktop",
    dimensions: "1440 × 900",
    width: 1440,
    height: 900
  },
  {
    key: "tablet",
    label: "Tablet",
    dimensions: "834 × 1112",
    width: 834,
    height: 1112
  },
  {
    key: "phone",
    label: "Phone",
    dimensions: "390 × 844",
    width: 390,
    height: 844
  }
] as const;

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

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

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
  const selected = selectedScenario(firstParam(params?.scenario));
  if (firstParam(params?.mode) === "preview") {
    return <ScenarioPreview scenario={selected.key} />;
  }
  const previewHref = scenarioHref(selected.key, true);

  return (
    <main className="review-storyboard">
      <header className="storyboard-header">
        <div className="storyboard-brand product-wordmark">
          <img src="/agent-outbox-mark.svg" alt="" width="34" height="34" />
          <span>
            Agent <b>Outbox</b>
          </span>
          <i>Caller connect storyboard</i>
        </div>
        <div className="storyboard-header-actions">
          <Link href="/human">
            <ArrowLeft aria-hidden="true" /> Back to queue
          </Link>
          <a href={previewHref} target="_blank" rel="noreferrer">
            Open live viewport <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </header>

      <div className="storyboard-layout">
        <nav className="storyboard-index" aria-label="Caller connect scenarios">
          <div className="storyboard-index-intro">
            <span>Coverage catalog</span>
            <strong>{scenarios.length} connection scenarios</strong>
            <p>
              Choose a state, then inspect the real shared UI at each exact
              width.
            </p>
          </div>
          <ol>
            {scenarios.map((scenario, index) => (
              <li key={scenario.key}>
                <Link
                  className={
                    scenario.key === selected.key ? "selected" : undefined
                  }
                  href={scenarioHref(scenario.key)}
                  aria-current={
                    scenario.key === selected.key ? "page" : undefined
                  }
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{scenario.label}</strong>
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        <section className="storyboard-stage" aria-labelledby="story-title">
          <div className="storyboard-stage-header">
            <div>
              <p>{selected.label}</p>
              <h1 id="story-title">{selected.title}</h1>
              <span>
                Real caller-connect view · deterministic fixture state
              </span>
            </div>
          </div>

          <div className="storyboard-meta-row">
            <div className="storyboard-coverage" aria-label="Covered states">
              {selected.coverage.map((coverage) => (
                <span key={coverage}>{coverage}</span>
              ))}
            </div>
            <nav className="storyboard-width-nav" aria-label="Jump to width">
              {viewports.map((viewport) => (
                <a href={`#viewport-${viewport.key}`} key={viewport.key}>
                  {viewport.label} <span>{viewport.width}</span>
                </a>
              ))}
            </nav>
          </div>

          <div className="storyboard-frames" aria-label="Responsive previews">
            {viewports.map((viewport) => (
              <article
                className="storyboard-frame"
                key={viewport.key}
                id={`viewport-${viewport.key}`}
              >
                <header>
                  <div>
                    <span>{viewport.label}</span>
                    <small>{viewport.dimensions} · exact CSS pixels</small>
                  </div>
                  <a href={previewHref} target="_blank" rel="noreferrer">
                    Open separately <ExternalLink aria-hidden="true" />
                  </a>
                </header>
                <div className="storyboard-viewport">
                  <iframe
                    src={previewHref}
                    title={`${selected.label} at ${viewport.label} width`}
                    width={viewport.width}
                    height={viewport.height}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
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

  const setup: ConnectTerminalSetupData = {
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
