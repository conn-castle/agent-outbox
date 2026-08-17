import { MoreVertical, SkipForward } from "lucide-react";
import type { CSSProperties } from "react";

import {
  REVIEW_ROW_ANATOMY_PARTS,
  type ReviewRowAnatomyPartKey
} from "../../shared/review-row-anatomy";
import { resolveSupportedColor } from "../../shared/input-schema-rules.ts";
import { actionAppearanceClass } from "./action-appearance";
import { CardVisual } from "./TypedContent";
import { ReviewRowFrame } from "./ReviewRowFrame";
import { ReviewRowHeading } from "./ReviewRowHeading";

export type ReviewRowPreviewMode = "anatomy" | "example";

export function ReviewRowAnatomyFrame({
  mode = "anatomy"
}: {
  mode?: ReviewRowPreviewMode;
}) {
  const annotated = mode === "anatomy";
  const accent = resolveSupportedColor("purple");

  return (
    <div className="anatomy-queue-scroll queue-scroll">
      <div className="review-list">
        <div className="review-row-container">
          <ReviewRowFrame
            className={`review-row review-row-anatomy row-priority-high ${annotated ? "annotated" : "review-row-example"}`}
            style={
              {
                "--row-accent": accent,
                "--row-hover-accent": accent
              } as CSSProperties
            }
            heading={
              <ReviewRowHeading
                rowTypeDisplay={
                  annotated
                    ? REVIEW_ROW_ANATOMY_PARTS.rowType.label
                    : "Email draft"
                }
                rowTypeIcon="mail"
                corner={
                  <span
                    className={slotClass("corner", "corner-meta", annotated)}
                  >
                    {annotated
                      ? REVIEW_ROW_ANATOMY_PARTS.corner.label
                      : "Acme Corp · 4 min ago"}
                  </span>
                }
                contextLinks={[
                  {
                    key: "example-context-link",
                    display: annotated
                      ? REVIEW_ROW_ANATOMY_PARTS.contextLinks.label
                      : "View thread",
                    icon: "external-link",
                    href: "#review-row-anatomy"
                  }
                ]}
                contextAfter={
                  annotated ? (
                    <span className="priority priority-high">
                      {REVIEW_ROW_ANATOMY_PARTS.priority.label}
                    </span>
                  ) : (
                    <span className="sr-only">High priority</span>
                  )
                }
                utilities={
                  <>
                    <button
                      className={slotClass(
                        "skip",
                        "row-skip-button",
                        annotated
                      )}
                      type="button"
                    >
                      <SkipForward aria-hidden="true" />
                      <span>
                        {annotated
                          ? REVIEW_ROW_ANATOMY_PARTS.skip.label
                          : "Skip"}
                      </span>
                    </button>
                    <details className="row-overflow">
                      <summary
                        className={slotClass("overflowActions", "", annotated)}
                        aria-label={
                          REVIEW_ROW_ANATOMY_PARTS.overflowActions.label
                        }
                      >
                        <MoreVertical aria-hidden="true" />
                      </summary>
                      <div className="row-overflow-menu">
                        <button type="button">
                          {annotated
                            ? "Overflow action"
                            : "Escalate to support"}
                        </button>
                      </div>
                    </details>
                  </>
                }
                slotClassNames={{
                  rowType: slotClass("rowType", "", annotated),
                  contextLinks: slotClass("contextLinks", "", annotated)
                }}
              />
            }
            href="#review-row-anatomy"
            ariaLabel="Review row anatomy details"
            title={
              <span className="row-title">
                {annotated
                  ? "Title"
                  : "Reply to Acme Corp about the revised launch date"}
              </span>
            }
            subtitle={
              <span className="row-subtitle">
                {annotated
                  ? "Subtitle that demonstrates content-driven truncation"
                  : "Prepared customer response · support@agent-outbox.dev"}
              </span>
            }
            visual={
              <CardVisual
                visual={{
                  kind: "progress_ring",
                  payload: {
                    label: annotated ? "Confidence" : "Draft confidence",
                    value: annotated ? 64 : 92,
                    display: annotated ? "64%" : "92%",
                    unit: null,
                    min_value: 0,
                    max_value: 100,
                    color: "green"
                  }
                }}
              />
            }
            summary={
              <span className="row-proposal">
                {annotated
                  ? "Summary that can use a second line when the supplied content needs more vertical room."
                  : "The reply confirms the new September 8 launch date and offers a migration call."}
              </span>
            }
            details={
              annotated ? REVIEW_ROW_ANATOMY_PARTS.details.label : "Details"
            }
            actions={
              <div className="inline-actions" aria-label="Example actions">
                <button
                  className={
                    annotated
                      ? "inline-action-button"
                      : actionAppearanceClass("inline-action-button", {
                          tone: "success",
                          style: "solid"
                        })
                  }
                  type="button"
                >
                  {annotated ? "Primary action" : "Approve to send"}
                </button>
                <button
                  className={
                    annotated
                      ? "inline-action-button"
                      : actionAppearanceClass("inline-action-button", {
                          tone: "brand",
                          style: "outline"
                        })
                  }
                  type="button"
                >
                  {annotated ? "Secondary action" : "Request changes"}
                </button>
              </div>
            }
            slotClassNames={{
              title: slotClass("title", "", annotated),
              visual: slotClass("visual", "", annotated),
              summary: slotClass("summary", "", annotated),
              details: slotClass("details", "", annotated),
              actions: slotClass("actions", "", annotated)
            }}
          />
        </div>
      </div>
      {annotated ? (
        <span
          className={slotClass("scrollbar", "anatomy-scrollbar-label", true)}
        >
          Scrollbar
        </span>
      ) : null}
    </div>
  );
}

export function ReviewRowAnatomyViewport({
  width,
  mode = "anatomy"
}: {
  width: number;
  mode?: ReviewRowPreviewMode;
}) {
  return (
    <div
      className="human-workspace human-row-anatomy-page human-row-anatomy-preview"
      style={
        {
          "--anatomy-preview-width": `${width}px`
        } as CSSProperties
      }
    >
      <ReviewRowAnatomyFrame mode={mode} />
    </div>
  );
}

function slotClass(
  key: ReviewRowAnatomyPartKey,
  base = "",
  annotated = true
): string {
  if (!annotated) return base;
  const slot = REVIEW_ROW_ANATOMY_PARTS[key];
  return [
    base,
    "anatomy-slot",
    `anatomy-owner-${slot.owner}`,
    slot.sizeBehavior ? `anatomy-size-${slot.sizeBehavior}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}
