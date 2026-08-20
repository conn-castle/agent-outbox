"use client";

import { useState, type CSSProperties } from "react";

import {
  REVIEW_ROW_ANATOMY_PARTS,
  REVIEW_ROW_ANATOMY_VIEWPORTS,
  REVIEW_ROW_SIZE_BEHAVIORS
} from "../../shared/review-row-anatomy";
import { ReviewRowAnatomyViewport } from "../human/ReviewRowAnatomyFrame";

export function ReviewRowAnatomyGallery() {
  return (
    <section className="review-row-anatomy-gallery" id="review-row-anatomy">
      <div className="anatomy-legends">
        <div className="anatomy-legend" aria-label="Anatomy categories">
          <strong>Category</strong>
          <span>Content · Controls · Infrastructure · Modifiers</span>
        </div>
        <div className="anatomy-legend" aria-label="Slot ownership colors">
          <strong>Background: ownership</strong>
          <span className="anatomy-owner-caller">Caller-controlled</span>
          <span className="anatomy-owner-product">Agent Outbox control</span>
        </div>
        <div className="anatomy-legend" aria-label="Content sizing borders">
          <strong>Border: content sizing</strong>
          {Object.entries(REVIEW_ROW_SIZE_BEHAVIORS).map(([key, behavior]) => (
            <span className={`anatomy-size-${key}`} key={key}>
              {behavior.label}
            </span>
          ))}
        </div>
      </div>

      <p className="anatomy-sizing-note">
        Border colors describe how content can resize a slot inside the current
        responsive layout. Viewport-driven reflow is shown separately at each
        exact width below.
      </p>

      <div className="canonical-anatomy-frames">
        {REVIEW_ROW_ANATOMY_VIEWPORTS.map((viewport) => (
          <AnatomyPreviewCard key={viewport.key} viewport={viewport} />
        ))}
      </div>

      <div className="anatomy-field-table-wrap">
        <table className="anatomy-field-table">
          <thead>
            <tr>
              <th>Element</th>
              <th>Category</th>
              <th>API setting</th>
              <th>Owner</th>
              <th>Content sizing</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(REVIEW_ROW_ANATOMY_PARTS).map((slot) => (
              <tr key={slot.label}>
                <th>{slot.label}</th>
                <td>{categoryLabel(slot.kind)}</td>
                <td>
                  {slot.fields.length > 0
                    ? slot.fields.map((field) => (
                        <code key={field}>{field}</code>
                      ))
                    : "Product layout"}
                </td>
                <td>{slot.owner === "caller" ? "Caller" : "Agent Outbox"}</td>
                <td>
                  {slot.sizeBehavior ? (
                    <span className={`anatomy-size-${slot.sizeBehavior}`}>
                      {REVIEW_ROW_SIZE_BEHAVIORS[slot.sizeBehavior].label}
                    </span>
                  ) : (
                    "Not a content box"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function categoryLabel(
  kind: (typeof REVIEW_ROW_ANATOMY_PARTS)[keyof typeof REVIEW_ROW_ANATOMY_PARTS]["kind"]
) {
  switch (kind) {
    case "content":
      return "Content slot";
    case "control":
      return "Product control";
    case "infrastructure":
      return "Responsive infrastructure";
    case "modifier":
      return "Row modifier";
  }
}

function AnatomyPreviewCard({
  viewport
}: {
  viewport: (typeof REVIEW_ROW_ANATOMY_VIEWPORTS)[number];
}) {
  const [mode, setMode] = useState<"anatomy" | "example">("anatomy");
  const isExample = mode === "example";

  return (
    <article
      className="canonical-anatomy-frame"
      style={
        {
          "--anatomy-preview-width": `${viewport.width}px`
        } as CSSProperties
      }
    >
      <header>
        <span className="canonical-anatomy-heading">
          <strong>{viewport.label}</strong>
          <span>{viewport.width}px viewport</span>
        </span>
        <span className="canonical-anatomy-actions">
          <button
            type="button"
            data-mode={mode}
            onClick={() => setMode(isExample ? "anatomy" : "example")}
          >
            {isExample ? "Show anatomy" : "Show example"}
          </button>
          <a
            href={`/docs/api/row-anatomy?width=${viewport.width}&mode=${mode}`}
            target="_blank"
            rel="noreferrer"
          >
            Open preview
          </a>
        </span>
      </header>
      <div
        className="canonical-anatomy-viewport"
        aria-label={`${viewport.label} horizontally scrollable preview`}
        tabIndex={0}
      >
        <ReviewRowAnatomyViewport width={viewport.width} mode={mode} />
      </div>
    </article>
  );
}
