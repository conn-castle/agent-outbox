import { Check, ChevronRight, Clock3, MoreHorizontal } from "lucide-react";

import type { HumanReviewListRow } from "../../server/human-review.ts";
import {
  humanReviewHref,
  type HumanReviewView
} from "../../shared/human-review-view";
import { InlineQuickAction } from "./ActionForms";
import {
  formatQueueTimestamp,
  formatReviewPriority,
  formatUtcTimestamp
} from "./review-format";
import { HumanIcon, ReviewSignal, SafeHtml } from "./TypedContent";

export function ReviewList({
  rows,
  selectedId,
  selectedIds,
  skippedIds,
  onSelectedChange,
  onSkipToggle,
  selectionMode,
  view,
  renderedAt
}: {
  rows: HumanReviewListRow[];
  selectedId: string | null;
  selectedIds: Set<string>;
  skippedIds: Set<string>;
  onSelectedChange: (inputItemId: string, selected: boolean) => void;
  onSkipToggle: (inputItemId: string) => void;
  selectionMode: boolean;
  view: HumanReviewView;
  renderedAt: string;
}) {
  if (rows.length === 0) {
    return (
      <section className="empty-state queue-empty">
        <span className="empty-state-icon">
          <Check aria-hidden="true" />
        </span>
        <h2>Queue clear</h2>
        <p>No reviews match this view.</p>
      </section>
    );
  }

  return (
    <ol className="review-list" aria-label="Review queue">
      {rows.map((row) => {
        const title = plainText(row.titleHtml);
        const selected = row.inputItemId === selectedId;
        const risk = queueRisk(row);
        return (
          <li key={row.inputItemId}>
            <article
              className={`review-row risk-${risk}${selected ? " selected" : ""}${
                selectionMode ? " selection-mode" : ""
              }`}
            >
              {selectionMode ? (
                <label className="row-select">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.inputItemId)}
                    disabled={row.status !== "pending"}
                    onChange={(event) =>
                      onSelectedChange(row.inputItemId, event.target.checked)
                    }
                  />
                  <span className="sr-only">Select review</span>
                </label>
              ) : null}

              <div className="row-copy">
                <div className="row-source">
                  <span className="row-type">
                    <span className="row-type-icon">
                      <HumanIcon name={row.rowType.icon} />
                    </span>
                    {row.rowType.display}
                  </span>
                  <span className="mobile-row-caller">
                    {row.caller.displayName}
                  </span>
                  <span className="row-source-meta">
                    <span className="row-source-divider" aria-hidden="true">
                      ·
                    </span>
                    <span className="row-caller">{row.caller.displayName}</span>
                    {row.cornerHtml ? (
                      <SafeHtml html={row.cornerHtml} className="row-corner" />
                    ) : null}
                    {skippedIds.has(row.inputItemId) ? (
                      <span className="status-pill">skipped</span>
                    ) : null}
                  </span>
                </div>

                <div className="row-main">
                  <a
                    className="row-link"
                    href={humanReviewHref(view, row.inputItemId)}
                  >
                    <span className="row-link-heading">
                      <SafeHtml html={row.titleHtml} className="row-title" />
                    </span>
                    <SafeHtml html={row.summaryHtml} className="row-proposal" />
                  </a>
                  <div className="row-footer">
                    {view.status !== "pending" ? (
                      <span className={`status-indicator status-${row.status}`}>
                        {row.status}
                      </span>
                    ) : null}
                    <SafeHtml html={row.subtitleHtml} className="row-context" />
                    {row.output ? (
                      <span>Answered {row.output.actionValue}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="row-control-zone">
                <div className="row-signal-zone">
                  {row.priority !== "normal" ? (
                    <span className={`priority priority-${row.priority}`}>
                      {formatReviewPriority(row.priority)}
                    </span>
                  ) : null}
                  <div className="row-visual">
                    <ReviewSignal visual={row.cardVisual} />
                  </div>
                  <time
                    className="row-time"
                    dateTime={row.updatedAt}
                    title={`${formatUtcTimestamp(row.updatedAt)} UTC`}
                  >
                    {formatQueueTimestamp(row.updatedAt, renderedAt)}
                  </time>
                </div>

                <div
                  className={`row-actions${
                    row.bulkActions.length === 0 ? " review-only" : ""
                  }`}
                >
                  {row.status === "pending" && row.bulkActions.length > 0 ? (
                    <div
                      className="inline-actions"
                      role="group"
                      aria-label={`Quick actions for ${title}`}
                    >
                      {row.bulkActions.map((action) => (
                        <InlineQuickAction
                          key={action.value}
                          row={row}
                          action={action}
                        />
                      ))}
                      {row.bulkActions.length === 1 ? (
                        <a
                          className="inline-review-link"
                          href={humanReviewHref(view, row.inputItemId)}
                          aria-label={`Review details for ${title}`}
                        >
                          <span>Details</span>
                          <ChevronRight aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                  {row.status === "pending" && row.bulkActions.length === 0 ? (
                    <a
                      className="row-review-link review-required"
                      href={humanReviewHref(view, row.inputItemId)}
                      aria-label={"Open review " + title}
                    >
                      <span>Details</span>
                      <ChevronRight aria-hidden="true" />
                    </a>
                  ) : null}
                  <div className="row-secondary-actions">
                    <details className="row-overflow">
                      <summary
                        role="button"
                        aria-label={`More actions for ${title}`}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </summary>
                      <div className="row-overflow-menu">
                        <button
                          type="button"
                          disabled={row.skipDisabled}
                          onClick={(event) => {
                            onSkipToggle(row.inputItemId);
                            event.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                          }}
                        >
                          <Clock3 aria-hidden="true" />
                          <span>
                            {skippedIds.has(row.inputItemId)
                              ? "Return to active queue"
                              : "Skip for now"}
                          </span>
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function plainText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queueRisk(row: HumanReviewListRow) {
  const payload = row.cardVisual?.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const value = payload.queue_risk;
    if (value === "high" || value === "medium" || value === "low") {
      return value;
    }
  }
  return "medium";
}
