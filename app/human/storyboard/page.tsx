import { Rows3 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ReviewRowAnatomyGallery } from "../../../src/components/docs/ReviewRowAnatomyGallery";
import {
  StoryboardHeader,
  StoryboardShell
} from "../../../src/components/StoryboardShell";
import {
  browserFixtureStoryboardScenarios,
  humanBrowserFixtureEnabled
} from "../../../src/server/human-review-fixture";
import { firstSearchParam } from "../../../src/shared/human-review-view";

export const dynamic = "force-dynamic";

type StoryboardMode = "queue" | "detail" | "layout";

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

  return (
    <StoryboardShell
      label="UI storyboard"
      previewHref={humanPreviewHref(selected, mode)}
      indexLabel="Fixture scenarios"
      countLabel={`${scenarios.length} review scenarios`}
      intro="Choose an item, then inspect its real UI at each exact width."
      scenarios={scenarios.map((scenario) => ({
        key: scenario.inputItemId,
        href: storyboardHref(scenario.inputItemId, mode),
        label: scenario.useCase,
        selected: scenario.inputItemId === selected.inputItemId
      }))}
      eyebrow={selected.useCase}
      title={selected.title}
      subtitle={selected.callerItemId}
      modeNav={
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
      }
      coverage={selected.coverage}
    />
  );
}

function RowLayoutStoryboard() {
  return (
    <main className="review-storyboard row-layout-storyboard">
      <StoryboardHeader label="Row anatomy" />

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
  scenario: {
    inputItemId: string;
    callerItemId: string;
    status: "pending" | "answered";
  },
  mode: StoryboardMode
) {
  const params = new URLSearchParams({ status: scenario.status });
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
