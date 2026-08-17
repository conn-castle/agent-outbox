import type { Metadata } from "next";

import { ReviewRowAnatomyViewport } from "../../../../src/components/human/ReviewRowAnatomyFrame";
import { REVIEW_ROW_ANATOMY_VIEWPORTS } from "../../../../src/shared/review-row-anatomy";

export const metadata: Metadata = {
  title: "Review row anatomy | Agent Outbox",
  robots: { index: false, follow: false }
};

export default async function ReviewRowAnatomyPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestedWidth = Number(
    Array.isArray(params?.width) ? params.width[0] : params?.width
  );
  const width =
    REVIEW_ROW_ANATOMY_VIEWPORTS.find(
      (viewport) => viewport.width === requestedWidth
    )?.width ?? REVIEW_ROW_ANATOMY_VIEWPORTS[0].width;
  const mode = params?.mode === "example" ? "example" : "anatomy";

  return (
    <main className="human-row-anatomy-popout">
      <header>
        <h1>Canonical review row</h1>
        <p>
          {width}px responsive preview · {mode}
        </p>
      </header>
      <div className="human-row-anatomy-popout-scroll">
        <ReviewRowAnatomyViewport width={width} mode={mode} />
      </div>
    </main>
  );
}
