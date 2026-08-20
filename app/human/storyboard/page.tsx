import { ArrowLeft, ExternalLink, Rows3 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ReviewRowAnatomyGallery } from "../../../src/components/docs/ReviewRowAnatomyGallery";
import {
  browserFixtureStoryboardScenarios,
  humanBrowserFixtureEnabled
} from "../../../src/server/human-review-fixture";
import { firstSearchParam } from "../../../src/shared/human-review-view";

export const dynamic = "force-dynamic";

type StoryboardMode = "queue" | "detail" | "layout";

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

export default async function HumanStoryboardPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!humanBrowserFixtureEnabled()) {
    notFound();
  }

  const params = await searchParams;
  if (firstSearchParam(params?.mode) === "layout") {
    return <RowLayoutStoryboard />;
  }
  const scenarios = browserFixtureStoryboardScenarios();
  const requestedScenario = firstSearchParam(params?.scenario);
  const selected =
    scenarios.find(
      (scenario) =>
        scenario.inputItemId === requestedScenario ||
        scenario.callerItemId === requestedScenario
    ) ?? scenarios[0];
  if (!selected) {
    notFound();
  }
  const mode: StoryboardMode =
    firstSearchParam(params?.mode) === "queue" ? "queue" : "detail";
  const previewHref = humanPreviewHref(selected, mode);

  return (
    <main className="review-storyboard">
      <header className="storyboard-header">
        <div className="storyboard-brand product-wordmark">
          <img src="/agent-outbox-mark.svg" alt="" width="34" height="34" />
          <span>
            Agent <b>Outbox</b>
          </span>
          <i>UI storyboard</i>
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
        <nav className="storyboard-index" aria-label="Fixture scenarios">
          <div className="storyboard-index-intro">
            <span>Coverage catalog</span>
            <strong>{scenarios.length} review scenarios</strong>
            <p>Choose an item, then inspect its real UI at each exact width.</p>
          </div>
          <ol>
            {scenarios.map((scenario, index) => (
              <li key={scenario.inputItemId}>
                <Link
                  className={
                    scenario.inputItemId === selected.inputItemId
                      ? "selected"
                      : undefined
                  }
                  href={storyboardHref(scenario.inputItemId, mode)}
                  aria-current={
                    scenario.inputItemId === selected.inputItemId
                      ? "page"
                      : undefined
                  }
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{scenario.useCase}</strong>
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        <section className="storyboard-stage" aria-labelledby="story-title">
          <div className="storyboard-stage-header">
            <div>
              <p>{selected.useCase}</p>
              <h1 id="story-title">{selected.title}</h1>
              <span>{selected.callerItemId}</span>
            </div>
            <nav className="storyboard-mode" aria-label="Preview mode">
              <Link
                className={mode === "queue" ? "selected" : undefined}
                href={storyboardHref(selected.inputItemId, "queue")}
              >
                <Rows3 aria-hidden="true" /> Queue
              </Link>
              <Link
                className={mode === "detail" ? "selected" : undefined}
                href={storyboardHref(selected.inputItemId, "detail")}
              >
                Detail
              </Link>
            </nav>
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
                    title={`${selected.useCase} at ${viewport.label} width`}
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

function RowLayoutStoryboard() {
  return (
    <main className="review-storyboard row-layout-storyboard">
      <header className="storyboard-header">
        <div className="storyboard-brand product-wordmark">
          <img src="/agent-outbox-mark.svg" alt="" width="34" height="34" />
          <span>
            Agent <b>Outbox</b>
          </span>
          <i>Row anatomy</i>
        </div>
        <div className="storyboard-header-actions">
          <Link href="/human">
            <ArrowLeft aria-hidden="true" /> Back to queue
          </Link>
        </div>
      </header>

      <section className="row-layout-stage" aria-labelledby="row-layout-title">
        <header className="row-layout-intro">
          <div>
            <p>Responsive layout diagnostic</p>
            <h1 id="row-layout-title">Review row slots</h1>
            <span>
              Placeholder labels and temporary colors expose alignment,
              truncation, and responsive behavior.
            </span>
          </div>
        </header>
        <ReviewRowAnatomyGallery />
      </section>
    </main>
  );
}

function humanPreviewHref(
  scenario: { inputItemId: string; callerItemId: string },
  mode: StoryboardMode
) {
  const params = new URLSearchParams({ status: "all" });
  if (mode === "detail") {
    params.set("item", scenario.inputItemId);
  } else {
    params.set("search", scenario.callerItemId);
  }
  return `/human?${params.toString()}`;
}

function storyboardHref(inputItemId: string, mode: StoryboardMode) {
  return `/human/storyboard?${new URLSearchParams({
    scenario: inputItemId,
    mode
  }).toString()}`;
}
