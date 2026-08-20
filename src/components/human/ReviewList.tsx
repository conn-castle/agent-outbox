import { Check, MoreVertical, SkipForward, Undo2 } from "lucide-react";
import type { CSSProperties } from "react";

import type { HumanReviewListRow } from "../../server/human-review.ts";
import {
  humanReviewHref,
  type HumanReviewView
} from "../../shared/human-review-view";
import { resolveSupportedColor } from "../../shared/input-schema-rules.ts";
import { InlineQuickAction } from "./ActionForms";
import { formatQueueTimestamp, formatUtcTimestamp } from "./review-format";
import { CardVisual, HumanIcon, SafeHtml, safeHref } from "./TypedContent";
import { ReviewRowFrame } from "./ReviewRowFrame";
import { ReviewRowHeading } from "./ReviewRowHeading";
import { actionAppearanceClass } from "./action-appearance";
import { formatReviewPriority } from "./review-format";

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
        const rowAccentColor = row.rowAccentColor
          ? resolveSupportedColor(row.rowAccentColor)
          : null;
        const rowHref = humanReviewHref(view, row.inputItemId);
        const contextLinks = (row.linkButtons ?? []).flatMap((link) => {
          const href = safeHref(link.url);
          return href
            ? [
                {
                  key: link.displayOrder,
                  display: link.display,
                  icon: link.icon,
                  href,
                  external: true
                }
              ]
            : [];
        });
        return (
          <li key={row.inputItemId}>
            <ReviewRowFrame
              className={`review-row row-priority-${row.priority}${rowAccentColor ? "" : " row-accent-default"}${selected ? " selected" : ""}${
                selectionMode ? " selection-mode" : ""
              }`}
              style={
                {
                  "--row-accent": rowAccentColor ?? "#7a746c",
                  "--row-hover-accent": rowAccentColor ?? "#7a746c"
                } as CSSProperties
              }
              selection={
                selectionMode ? (
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
                ) : null
              }
              heading={
                <ReviewRowHeading
                  rowTypeDisplay={row.rowType.display}
                  rowTypeIcon={row.rowType.icon}
                  corner={
                    row.cornerHtml ? (
                      <SafeHtml html={row.cornerHtml} className="corner-meta" />
                    ) : (
                      <time
                        className="corner-meta row-time product-fallback-meta"
                        dateTime={row.updatedAt}
                        title={`${formatUtcTimestamp(row.updatedAt)} UTC`}
                      >
                        {formatQueueTimestamp(row.updatedAt, renderedAt)}
                      </time>
                    )
                  }
                  contextLinks={contextLinks}
                  contextAfter={
                    <>
                      <span className="sr-only">
                        {formatReviewPriority(row.priority)}
                      </span>
                      {skippedIds.has(row.inputItemId) ? (
                        <span className="status-pill">skipped</span>
                      ) : null}
                    </>
                  }
                  utilities={
                    <>
                      {row.status === "pending" ? (
                        <button
                          className="row-skip-button"
                          type="button"
                          disabled={row.skipDisabled}
                          title={
                            row.skipDisabled
                              ? "Skipping is disabled for this review"
                              : undefined
                          }
                          onClick={() => onSkipToggle(row.inputItemId)}
                        >
                          {skippedIds.has(row.inputItemId) ? (
                            <Undo2 aria-hidden="true" />
                          ) : (
                            <SkipForward aria-hidden="true" />
                          )}
                          <span>
                            {skippedIds.has(row.inputItemId)
                              ? "Return"
                              : "Skip"}
                          </span>
                        </button>
                      ) : null}
                      {row.hasOverflowActions ? (
                        <details
                          className="row-overflow"
                          data-dismissible-disclosure
                        >
                          <summary aria-label={`More actions for ${title}`}>
                            <MoreVertical aria-hidden="true" />
                          </summary>
                          <div className="row-overflow-menu">
                            <a href={rowHref}>Review remaining outcomes</a>
                          </div>
                        </details>
                      ) : (
                        <button
                          className="row-overflow-disabled"
                          type="button"
                          aria-disabled="true"
                          aria-label={`No more actions for ${title}`}
                          title="No more actions"
                        >
                          <MoreVertical aria-hidden="true" />
                        </button>
                      )}
                    </>
                  }
                />
              }
              href={rowHref}
              ariaLabel={`Open review details for ${title}`}
              title={<SafeHtml html={row.titleHtml} className="row-title" />}
              subtitle={
                <SafeHtml html={row.subtitleHtml} className="row-subtitle" />
              }
              visual={
                row.cardVisual ? <CardVisual visual={row.cardVisual} /> : null
              }
              summary={
                <SafeHtml html={row.summaryHtml} className="row-proposal" />
              }
              footer={
                view.status !== "pending" || row.output ? (
                  <>
                    {view.status !== "pending" ? (
                      <span className={`status-indicator status-${row.status}`}>
                        {row.status}
                      </span>
                    ) : null}
                    {row.output ? (
                      <span>Answered {row.output.actionDisplay}</span>
                    ) : null}
                  </>
                ) : undefined
              }
              actions={
                row.status === "pending" &&
                row.bulkActions.some((action) => !action.overflow) ? (
                  <div
                    className="inline-actions"
                    role="group"
                    aria-label={`Quick actions for ${title}`}
                  >
                    {row.bulkActions
                      .filter((action) => !action.overflow)
                      .map((action) =>
                        action.popupKind !== "none" ? (
                          <a
                            key={action.value}
                            className={quickActionClass(action)}
                            href={humanReviewHref(
                              view,
                              row.inputItemId,
                              action.value
                            )}
                            title={action.display}
                          >
                            <HumanIcon name={action.icon} />
                            <span>{action.display}</span>
                          </a>
                        ) : (
                          <InlineQuickAction
                            key={action.value}
                            row={row}
                            action={action}
                          />
                        )
                      )}
                  </div>
                ) : null
              }
            />
          </li>
        );
      })}
    </ol>
  );
}

function quickActionClass(action: HumanReviewListRow["bulkActions"][number]) {
  return actionAppearanceClass("inline-action-button", action);
}

function plainText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
