import {
  Check,
  CircleAlert,
  Copy,
  Link2,
  MoreVertical,
  AlarmClock,
  Undo2
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";

import type {
  HumanReviewBulkAction,
  HumanReviewListRow
} from "../../server/human-review.ts";
import {
  humanReviewHref,
  humanReviewCardHref,
  type HumanReviewView
} from "../../shared/human-review-view";
import { htmlToPlainText } from "../../shared/html-text";
import { resolveSupportedColor } from "../../shared/input-schema-rules.ts";
import { InlineQuickAction, type OnHumanMutation } from "./ActionForms";
import { formatQueueTimestamp, formatExactUtcTimestamp } from "./review-format";
import { CardVisual, HumanIcon, SafeHtml, safeHref } from "./TypedContent";
import { ReviewRowFrame } from "./ReviewRowFrame";
import {
  ReviewRowHeading,
  type ReviewRowHeadingLink,
  type ReviewRowHeadingProps
} from "./ReviewRowHeading";
import { Feedback } from "./Feedback";
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
  feedbackDrafts,
  onFeedbackChange,
  feedbackError,
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
  feedbackDrafts: Record<string, string>;
  onFeedbackChange: (inputItemId: string, text: string) => boolean;
  feedbackError: string | null;
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
        const title = htmlToPlainText(row.titleHtml);
        const selected = row.inputItemId === selectedId;
        const rowAccentColor = row.rowAccentColor
          ? resolveSupportedColor(row.rowAccentColor)
          : null;
        const rowHref = humanReviewHref(view, row.inputItemId);
        const overflowActions =
          row.status === "pending"
            ? row.bulkActions.filter((action) => action.overflow)
            : [];
        const renderAction = (
          action: HumanReviewBulkAction,
          overflow: boolean,
          handleMutation: OnHumanMutation
        ) => {
          const className = overflow
            ? "row-overflow-item"
            : actionAppearanceClass("inline-action-button", action);
          return action.popupKind !== "none" ? (
            <Link
              key={action.value}
              className={className}
              href={humanReviewHref(view, row.inputItemId, action.value)}
              onNavigate={() => onDetailNavigate(row.inputItemId, title)}
              title={overflow ? undefined : action.display}
            >
              <HumanIcon name={action.icon} />
              <span>{action.display}</span>
            </Link>
          ) : (
            <InlineQuickAction
              key={action.value}
              row={row}
              action={action}
              className={className}
              onMutation={handleMutation}
            />
          );
        };
        return (
          <OptimisticReviewRow key={row.inputItemId} onMutation={onMutation}>
            {(handleMutation) => (
              <li
                id={`review-row-${row.inputItemId}`}
                aria-busy={locked || undefined}
                inert={locked || undefined}
              >
                <ReviewRowFrame
                  className={`review-row row-status-${row.status}${rowAccentColor ? "" : " row-accent-default"}${selected ? " selected" : ""}${
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
                    <ReviewListHeading
                      linkButtons={row.linkButtons}
                      rowTypeDisplay={row.rowType.display}
                      rowTypeIcon={row.rowType.icon}
                      cardTime={
                        row.cardTime ? (
                          <time
                            className="corner-meta row-time"
                            dateTime={row.cardTime}
                            title={formatExactUtcTimestamp(row.cardTime)}
                          >
                            <span className="sr-only">Card time: </span>
                            {formatQueueTimestamp(row.cardTime, renderedAt)}
                          </time>
                        ) : null
                      }
                      corner={
                        row.cornerHtml ? (
                          <SafeHtml
                            html={row.cornerHtml}
                            className="corner-meta"
                          />
                        ) : null
                      }
                      contextAfter={
                        <>
                          {skippedIds.has(row.inputItemId) ? (
                            <span className="status-pill">snoozed</span>
                          ) : null}
                        </>
                      }
                      utilities={
                        <>
                          <CopyReviewValue identifier={row.callerItemId} />
                          {row.status === "pending" ? (
                            <Feedback
                              value={feedbackDrafts[row.inputItemId] ?? ""}
                              onChange={(text) =>
                                onFeedbackChange(row.inputItemId, text)
                              }
                              error={feedbackError}
                            />
                          ) : null}
                          {row.status === "pending" ? (
                            <button
                              className="row-skip-button"
                              type="button"
                              disabled={row.skipDisabled}
                              title={
                                row.skipDisabled
                                  ? "Snoozing is disabled for this review"
                                  : skippedIds.has(row.inputItemId)
                                    ? "Return review to queue"
                                    : "Snooze review"
                              }
                              aria-label={
                                row.skipDisabled
                                  ? "Snooze unavailable for this review"
                                  : skippedIds.has(row.inputItemId)
                                    ? "Return review to queue"
                                    : "Snooze review"
                              }
                              onClick={() => onSkipToggle(row.inputItemId)}
                            >
                              {skippedIds.has(row.inputItemId) ? (
                                <Undo2 aria-hidden="true" />
                              ) : (
                                <AlarmClock aria-hidden="true" />
                              )}
                            </button>
                          ) : null}
                          <details
                            className="row-overflow"
                            data-dismissible-disclosure
                          >
                            <summary aria-label={`More actions for ${title}`}>
                              <MoreVertical aria-hidden="true" />
                            </summary>
                            <div className="row-overflow-menu">
                              <CopyReviewValue
                                identifier={row.callerItemId}
                                linkHref={humanReviewCardHref(
                                  row.caller.callerId,
                                  row.callerItemId
                                )}
                              />
                              {overflowActions.map((action) =>
                                renderAction(action, true, handleMutation)
                              )}
                            </div>
                          </details>
                        </>
                      }
                    />
                  }
                  href={rowHref}
                  ariaLabel={`Open review details for ${title}`}
                  onNavigate={() => onDetailNavigate(row.inputItemId, title)}
                  title={
                    <div className="row-title-line">
                      <SafeHtml
                        html={htmlWithoutAnchors(row.titleHtml)}
                        className="row-title"
                      />
                      <span
                        className={`row-priority priority-${row.priority}`}
                        aria-label={formatReviewPriority(row.priority)}
                      >
                        {row.priority.charAt(0).toUpperCase() +
                          row.priority.slice(1)}
                      </span>
                    </div>
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
                            renderAction(action, false, handleMutation)
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

function reviewRowContextLinks(
  linkButtons: HumanReviewListRow["linkButtons"]
): ReviewRowHeadingLink[] {
  return (linkButtons ?? []).flatMap((link) => {
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
}

function ReviewListHeading({
  linkButtons,
  ...heading
}: Omit<ReviewRowHeadingProps, "contextLinks"> & {
  linkButtons: HumanReviewListRow["linkButtons"];
}) {
  const contextLinks = useMemo(
    () => reviewRowContextLinks(linkButtons),
    [linkButtons]
  );
  return <ReviewRowHeading {...heading} contextLinks={contextLinks} />;
}

function CopyReviewValue({
  identifier,
  linkHref
}: {
  identifier: string;
  linkHref?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const label = linkHref ? "Copy link" : "Copy identifier";
  const copiedLabel = linkHref ? "Link copied" : "Identifier copied";
  const errorLabel = linkHref
    ? "Copy failed. Try again."
    : "Could not copy identifier. Try again.";
  const buttonLabel =
    status === "copied" ? copiedLabel : status === "error" ? errorLabel : label;
  async function copy() {
    // Clear the previous alert before even an immediately rejected retry.
    flushSync(() => setStatus("idle"));
    const value = linkHref
      ? new URL(linkHref, window.location.origin).href
      : identifier;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      } else {
        // Clipboard API requires HTTPS; support the trusted-LAN HTTP preview.
        const field = document.createElement("textarea");
        field.value = value;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        const focused = document.activeElement;
        try {
          field.select();
          if (!document.execCommand("copy")) throw new Error("Copy denied");
        } finally {
          field.remove();
          if (focused instanceof HTMLElement) focused.focus();
        }
      }
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }
  return (
    <span className={linkHref ? "row-link-copy" : "row-identifier-copy"}>
      <button
        type="button"
        className={`${linkHref ? "row-overflow-item" : "row-copy-button"}${status === "error" ? " copy-failed" : ""}`}
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={copy}
        onBlur={() => {
          setStatus("idle");
        }}
      >
        {status === "copied" ? (
          <Check aria-hidden="true" />
        ) : status === "error" ? (
          <CircleAlert aria-hidden="true" />
        ) : linkHref ? (
          <Link2 aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        {linkHref ? (
          <span>
            {status === "copied"
              ? copiedLabel
              : status === "error"
                ? "Copy failed"
                : label}
          </span>
        ) : null}
      </button>
      <span className="sr-only" role="status">
        {status === "copied" ? copiedLabel : ""}
      </span>
      {status === "error" ? (
        <span className="sr-only" role="alert">
          {errorLabel}
        </span>
      ) : null}
    </span>
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

function htmlWithoutAnchors(html: string) {
  // The queue title is itself a link; keep caller HTML from nesting <a> tags.
  return html.replace(/<\/?a\b[^>]*>/gi, "");
}
