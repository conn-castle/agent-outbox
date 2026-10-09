"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent
} from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock,
  Inbox,
  RefreshCw,
  X
} from "lucide-react";

import type {
  HumanReviewAction,
  HumanReviewDetail as HumanReviewDetailDto
} from "../../server/human-review.ts";
import {
  ActionComposer,
  ActionTrigger,
  UndoAnswerForm,
  type OnHumanMutation
} from "./ActionForms";
import {
  formatReviewPriority,
  formatQueueTimestamp,
  formatUtcTimestamp,
  formatExactUtcTimestamp
} from "./review-format";
import { CardVisual, HumanIcon, LinkButtons, SafeHtml } from "./TypedContent";
import { Feedback } from "./Feedback";

export function ReviewDetail({
  detail,
  renderedAt,
  positionLabel,
  previousItem,
  nextItem,
  composeAction,
  onClose,
  feedback,
  onFeedbackChange,
  feedbackError,
  onMutation
}: {
  detail: HumanReviewDetailDto | null;
  renderedAt: string;
  positionLabel: string | null;
  previousItem: { href: string; label: string } | null;
  nextItem: { href: string; label: string } | null;
  composeAction?: string | null;
  onClose: () => void;
  feedback: string;
  onFeedbackChange: (text: string) => boolean;
  feedbackError: string | null;
  onMutation: OnHumanMutation;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPressRef = useRef(false);
  const requestedCompose = composeAction
    ? (detail?.actions.find(
        (action) =>
          action.value === composeAction &&
          action.popupKind !== "none" &&
          action.answerable
      ) ?? null)
    : null;
  const [activeActionValue, setActiveActionValue] = useState<string | null>(
    requestedCompose?.value ?? null
  );
  const [closing, setClosing] = useState(false);
  const timestampTooltipId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.focus();
    return () => dialog.close();
  }, []);

  function closeDetail() {
    if (closing) return;
    setClosing(true);
    dialogRef.current?.close();
    onClose();
  }

  // Shared by both dialog variants: Escape and a full backdrop press close it.
  const dialogProps = {
    ref: dialogRef,
    tabIndex: -1,
    onCancel: (event: SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      closeDetail();
    },
    onPointerDown: (event: PointerEvent<HTMLDialogElement>) => {
      backdropPressRef.current = event.target === event.currentTarget;
    },
    onClick: (event: MouseEvent<HTMLDialogElement>) => {
      if (!backdropPressRef.current) return;
      backdropPressRef.current = false;
      if (event.target === event.currentTarget) closeDetail();
    }
  };

  if (!detail) {
    return (
      <dialog
        {...dialogProps}
        className="detail-modal"
        aria-label="Review detail"
      >
        <section className="detail-pane empty-state" aria-label="Review detail">
          <span className="empty-state-icon">
            <CircleDot aria-hidden="true" />
          </span>
          <h2>Review unavailable</h2>
          <p>
            This card is no longer available, or you do not have access to it.
          </p>
          <button
            className="mobile-back"
            type="button"
            aria-label="Close detail"
            onClick={closeDetail}
          >
            Close
          </button>
        </section>
      </dialog>
    );
  }

  const primaryActions = detail.actions.filter((action) => !action.overflow);
  const secondaryActions = detail.actions.filter((action) => action.overflow);
  const showActions = detail.status === "pending" && detail.actions.length > 0;
  const activeAction = detail.actions.find(
    (action) => action.value === activeActionValue
  );
  // Triggers render only while no action is active.
  const renderTrigger = (
    action: HumanReviewAction,
    variant: "primary" | "overflow"
  ) => (
    <ActionTrigger
      key={action.value}
      detail={detail}
      action={action}
      variant={variant}
      onActivate={() => setActiveActionValue(action.value)}
      onMutation={onMutation}
    />
  );
  const timestamps = [
    { label: "Card time", value: detail.cardTime, Icon: Clock },
    { label: "Added to Outbox", value: detail.createdAt, Icon: Inbox },
    { label: "Updated in Outbox", value: detail.updatedAt, Icon: RefreshCw }
  ];

  return (
    <dialog
      {...dialogProps}
      id={`review-detail-${detail.inputItemId}`}
      className={`detail-modal${requestedCompose ? " compose-modal" : ""}`}
      aria-label={requestedCompose ? requestedCompose.display : "Review detail"}
    >
      <section
        className={`detail-pane${requestedCompose ? " compose-pane" : ""}`}
        aria-label="Review detail"
      >
        <div className="detail-topbar">
          {requestedCompose ? (
            <p className="compose-kicker">{requestedCompose.display}</p>
          ) : (
            <nav className="detail-stepper" aria-label="Review navigation">
              <StepperLink item={previousItem} label="Previous">
                <ChevronLeft aria-hidden="true" />
                <span>Previous</span>
              </StepperLink>
              {positionLabel ? (
                <span className="detail-position">{positionLabel}</span>
              ) : null}
              <StepperLink item={nextItem} label="Next">
                <span>Next</span>
                <ChevronRight aria-hidden="true" />
              </StepperLink>
            </nav>
          )}
          <button
            className="mobile-back"
            type="button"
            aria-label="Close detail"
            onClick={closeDetail}
          >
            <X className="close-icon" aria-hidden="true" />
            <span className="close-copy">Close</span>
          </button>
        </div>

        <div className="detail-scroll">
          <header className="detail-header">
            {detail.status === "pending" ? (
              <Feedback
                value={feedback}
                onChange={onFeedbackChange}
                error={feedbackError}
              />
            ) : null}
            <div className="detail-heading-copy">
              <p className="detail-kicker">
                <HumanIcon name={detail.rowType.icon} />
                <span>{detail.rowType.display}</span>
                <span aria-hidden="true">·</span>
                <span>{detail.caller.displayName}</span>
              </p>
              <SafeHtml html={detail.titleHtml} className="detail-title" />
              {requestedCompose ? null : (
                <SafeHtml
                  html={detail.subtitleHtml}
                  className="detail-subtitle"
                />
              )}
            </div>
            <dl className="detail-timestamps">
              {timestamps.map(({ label, value, Icon }) => {
                if (!value) return null;
                const readable = formatQueueTimestamp(value, renderedAt);
                const exact = formatExactUtcTimestamp(value);
                const tooltipId = `${timestampTooltipId}-${label.replaceAll(/\s+/g, "-").toLowerCase()}`;
                return (
                  <div key={label}>
                    <dt className="sr-only">{label}</dt>
                    <dd>
                      <time
                        dateTime={value}
                        tabIndex={0}
                        aria-describedby={tooltipId}
                      >
                        <Icon aria-hidden="true" />
                        {readable}
                      </time>
                      <span
                        id={tooltipId}
                        role="tooltip"
                        className="timestamp-tooltip"
                      >
                        {label}: {exact}
                      </span>
                      <span className="sr-only">; {exact}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </header>

          {requestedCompose ? (
            <SafeHtml html={detail.summaryHtml} className="detail-summary" />
          ) : (
            <>
              <div className="detail-meta">
                <span className={`priority priority-${detail.priority}`}>
                  {formatReviewPriority(detail.priority)}
                </span>
                <CardVisual visual={detail.cardVisual} />
                <span className={`detail-status status-${detail.status}`}>
                  {detail.status}
                </span>
                <span className="detail-revision">
                  Rev {detail.currentRevision}
                </span>
                <LinkButtons links={detail.linkButtons} />
                {detail.output ? (
                  <span>
                    Answered {detail.output.actionDisplay}
                    {detail.output.firstReadAt
                      ? ` · read ${detail.output.readCount} ${
                          detail.output.readCount === 1 ? "time" : "times"
                        }`
                      : " · unread by caller"}
                  </span>
                ) : null}
              </div>

              <article className="detail-content">
                <section>
                  <p className="detail-section-label">Review summary</p>
                  <SafeHtml
                    html={detail.summaryHtml}
                    className="detail-summary"
                  />
                </section>
                {detail.detailsHtml ? (
                  <section>
                    <p className="detail-section-label">Details</p>
                    <SafeHtml
                      html={detail.detailsHtml}
                      className="detail-body"
                    />
                  </section>
                ) : null}
              </article>

              {detail.output ? (
                <div className="answered-state" aria-label="Answered state">
                  <span className="answered-icon">
                    <Check aria-hidden="true" />
                  </span>
                  <div>
                    <strong>Answered with {detail.output.actionDisplay}</strong>
                    <span>{formatUtcTimestamp(detail.output.answeredAt)}</span>
                  </div>
                  <UndoAnswerForm detail={detail} onMutation={onMutation} />
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="action-section" aria-label="Your response">
          {requestedCompose ? (
            <ActionComposer
              detail={detail}
              action={requestedCompose}
              onCancel={closeDetail}
              onMutation={onMutation}
            />
          ) : (
            <>
              {!showActions ? (
                <p className="muted">This review has no pending actions.</p>
              ) : !activeAction ? (
                <div className="action-triggers">
                  <div className="primary-actions" aria-label="Primary actions">
                    {primaryActions.map((action) =>
                      renderTrigger(action, "primary")
                    )}
                  </div>
                  {secondaryActions.length === 1 ? (
                    <div className="secondary-direct">
                      {renderTrigger(secondaryActions[0], "overflow")}
                    </div>
                  ) : secondaryActions.length > 1 ? (
                    <div className="response-support">
                      <details className="secondary-actions">
                        <summary aria-label="More actions">
                          <span>Other responses</span>
                          <ChevronDown aria-hidden="true" />
                        </summary>
                        <div
                          className="secondary-actions-grid"
                          aria-label="More actions"
                        >
                          {secondaryActions.map((action) =>
                            renderTrigger(action, "overflow")
                          )}
                        </div>
                      </details>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {activeAction && activeAction.popupKind !== "none" ? (
                <ActionComposer
                  detail={detail}
                  action={activeAction}
                  onCancel={() => setActiveActionValue(null)}
                  onMutation={onMutation}
                />
              ) : null}
            </>
          )}
        </div>
      </section>
    </dialog>
  );
}

function StepperLink({
  item,
  label,
  children
}: {
  item: { href: string; label: string } | null;
  label: string;
  children: ReactNode;
}) {
  return item ? (
    <Link href={item.href} aria-label={`${label}: ${item.label}`}>
      {children}
    </Link>
  ) : (
    <span className="disabled">{children}</span>
  );
}

export function ReviewDetailLoading({
  label,
  onCancel
}: {
  label: string;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPressRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="detail-modal detail-loading-modal"
      aria-label={`Loading review details for ${label}`}
      onCancel={(event) => {
        event.preventDefault();
        dialogRef.current?.close();
        onCancel();
      }}
      onPointerDown={(event) => {
        backdropPressRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (backdropPressRef.current && event.target === event.currentTarget) {
          dialogRef.current?.close();
          onCancel();
        }
        backdropPressRef.current = false;
      }}
    >
      <section className="detail-pane detail-loading-pane" aria-live="polite">
        <span className="detail-loading-spinner" aria-hidden="true" />
        <div>
          <strong>Loading details…</strong>
          <span>{label}</span>
        </div>
      </section>
    </dialog>
  );
}
