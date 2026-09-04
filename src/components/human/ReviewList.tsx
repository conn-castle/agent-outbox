import { Check, MoreVertical, SkipForward, Undo2 } from "lucide-react";
import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";

import type { HumanReviewListRow } from "../../server/human-review.ts";
import {
  humanReviewHref,
  type HumanReviewView
} from "../../shared/human-review-view";
import { resolveSupportedColor } from "../../shared/input-schema-rules.ts";
import { InlineQuickAction, type OnHumanMutation } from "./ActionForms";
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
  renderedAt,
  onMutation,
  lockedIds,
  onDetailNavigate
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
  onMutation: OnHumanMutation;
  lockedIds: Set<string>;
  onDetailNavigate: (inputItemId: string, label: string) => void;
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
        const locked = lockedIds.has(row.inputItemId);
        const title = plainText(row.titleHtml);
        const selected = row.inputItemId === selectedId;
        const rowAccentColor = row.rowAccentColor
          ? resolveSupportedColor(row.rowAccentColor)
          : null;
        const rowHref = humanReviewHref(view, row.inputItemId);
        const overflowActions = row.bulkActions.filter(
          (action) => action.overflow
        );
        const contextLinks = (row.linkButtons ?? [])
          .flatMap((link) => {
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
          })
          .slice(0, 4);
        return (
          <OptimisticReviewRow key={row.inputItemId} onMutation={onMutation}>
            {(handleMutation) => (
              <li
                id={`review-row-${row.inputItemId}`}
                aria-busy={locked || undefined}
                inert={locked || undefined}
              >
                <ReviewRowFrame
                  className={`review-row row-status-${row.status} row-priority-${row.priority}${rowAccentColor ? "" : " row-accent-default"}${selected ? " selected" : ""}${
                    selectionMode ? " selection-mode" : ""
                  }`}
                  style={
                    rowAccentColor
                      ? ({
                          "--row-accent": rowAccentColor,
                          "--row-hover-accent": rowAccentColor
                        } as CSSProperties)
                      : undefined
                  }
                  selection={
                    selectionMode ? (
                      <label className="row-select">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.inputItemId)}
                          disabled={row.status !== "pending"}
                          onChange={(event) =>
                            onSelectedChange(
                              row.inputItemId,
                              event.target.checked
                            )
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
                          <SafeHtml
                            html={row.cornerHtml}
                            className="corner-meta"
                          />
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
                              aria-label={
                                row.skipDisabled
                                  ? "Defer unavailable for this review"
                                  : skippedIds.has(row.inputItemId)
                                    ? "Return review to queue"
                                    : "Defer review"
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
                                  : "Defer"}
                              </span>
                            </button>
                          ) : null}
                          {row.status === "pending" &&
                          overflowActions.length > 0 ? (
                            <details
                              className="row-overflow"
                              data-dismissible-disclosure
                            >
                              <summary aria-label={`More actions for ${title}`}>
                                <MoreVertical aria-hidden="true" />
                              </summary>
                              <div className="row-overflow-menu">
                                {overflowActions.map((action) =>
                                  action.popupKind !== "none" ? (
                                    <Link
                                      key={action.value}
                                      className="row-overflow-item"
                                      href={humanReviewHref(
                                        view,
                                        row.inputItemId,
                                        action.value
                                      )}
                                      onNavigate={() =>
                                        onDetailNavigate(row.inputItemId, title)
                                      }
                                    >
                                      <HumanIcon name={action.icon} />
                                      <span>{action.display}</span>
                                    </Link>
                                  ) : (
                                    <InlineQuickAction
                                      key={action.value}
                                      row={row}
                                      action={action}
                                      className="row-overflow-item"
                                      onMutation={handleMutation}
                                    />
                                  )
                                )}
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
                  onNavigate={() => onDetailNavigate(row.inputItemId, title)}
                  title={
                    <SafeHtml
                      html={htmlWithoutAnchors(row.titleHtml)}
                      className="row-title"
                    />
                  }
                  subtitle={
                    <SafeHtml
                      html={htmlWithoutAnchors(row.subtitleHtml)}
                      className="row-subtitle"
                    />
                  }
                  visual={
                    row.cardVisual ? (
                      <CardVisual visual={row.cardVisual} compact />
                    ) : null
                  }
                  summary={
                    <SafeHtml html={row.summaryHtml} className="row-proposal" />
                  }
                  footer={
                    view.status !== "pending" || row.output ? (
                      <>
                        {view.status !== "pending" ? (
                          <span
                            className={`status-indicator status-${row.status}`}
                          >
                            {row.status}
                          </span>
                        ) : null}
                        {row.output ? (
                          <span className="row-result">
                            Decision: {row.output.actionDisplay}
                          </span>
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
                              <Link
                                key={action.value}
                                className={quickActionClass(action)}
                                href={humanReviewHref(
                                  view,
                                  row.inputItemId,
                                  action.value
                                )}
                                onNavigate={() =>
                                  onDetailNavigate(row.inputItemId, title)
                                }
                                title={action.display}
                              >
                                <HumanIcon name={action.icon} />
                                <span>{action.display}</span>
                              </Link>
                            ) : (
                              <InlineQuickAction
                                key={action.value}
                                row={row}
                                action={action}
                                onMutation={handleMutation}
                              />
                            )
                          )}
                      </div>
                    ) : null
                  }
                />
              </li>
            )}
          </OptimisticReviewRow>
        );
      })}
    </ol>
  );
}

function OptimisticReviewRow({
  onMutation,
  children
}: {
  onMutation: OnHumanMutation;
  children: (onMutation: OnHumanMutation) => ReactNode;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const handleMutation: OnHumanMutation = (submission) => {
    flushSync(() => setHidden(true));
    onMutation(submission);
  };
  return children(handleMutation);
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

function htmlWithoutAnchors(html: string) {
  // The queue title is itself a link; keep caller HTML from nesting <a> tags.
  return html.replace(/<\/?a\b[^>]*>/gi, "");
}
