"use client";

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  X
} from "lucide-react";

import type { HumanReviewDetail as HumanReviewDetailDto } from "../../server/human-review.ts";
import {
  humanReviewHref,
  type HumanReviewView
} from "../../shared/human-review-view";
import {
  ActionComposer,
  ActionTrigger,
  UndoAnswerForm,
  type OnHumanMutation
} from "./ActionForms";
import { formatReviewPriority, formatUtcTimestamp } from "./review-format";
import { CardVisual, HumanIcon, LinkButtons, SafeHtml } from "./TypedContent";

export function ReviewDetail({
  detail,
  view,
  positionLabel,
  previousItem,
  nextItem,
  composeAction,
  onMutation
}: {
  detail: HumanReviewDetailDto | null;
  view: HumanReviewView;
  positionLabel: string | null;
  previousItem: { href: string; label: string } | null;
  nextItem: { href: string; label: string } | null;
  composeAction?: string | null;
  onMutation: OnHumanMutation;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPressRef = useRef(false);
  const requestedCompose = composeAction
    ? (detail?.actions.find(
        (action) =>
          action.value === composeAction && action.popupKind !== "none"
      ) ?? null)
    : null;
  const [activeActionValue, setActiveActionValue] = useState<string | null>(
    requestedCompose?.value ?? null
  );
  const [closing, setClosing] = useState(false);
  const closeHref = humanReviewHref(view);

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
    router.push(closeHref, { scroll: false });
  }

  function handleBackdropPointerDown(event: PointerEvent<HTMLDialogElement>) {
    backdropPressRef.current = event.target === event.currentTarget;
  }

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (!backdropPressRef.current) return;
    backdropPressRef.current = false;
    if (event.target === event.currentTarget) closeDetail();
  }

  if (!detail) {
    return (
      <dialog
        ref={dialogRef}
        className="detail-modal"
        aria-label="Review detail"
        tabIndex={-1}
        onCancel={(event) => {
          event.preventDefault();
          closeDetail();
        }}
        onPointerDown={handleBackdropPointerDown}
        onClick={handleBackdropClick}
      >
        <section className="detail-pane empty-state" aria-label="Review detail">
          <span className="empty-state-icon">
            <CircleDot aria-hidden="true" />
          </span>
          <h2>Review unavailable</h2>
          <p>This review could not be loaded.</p>
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

  return (
    <dialog
      ref={dialogRef}
      id={`review-detail-${detail.inputItemId}`}
      className={`detail-modal${requestedCompose ? " compose-modal" : ""}`}
      aria-label={requestedCompose ? requestedCompose.display : "Review detail"}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        closeDetail();
      }}
      onPointerDown={handleBackdropPointerDown}
      onClick={handleBackdropClick}
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
              {previousItem ? (
                <Link
                  href={previousItem.href}
                  aria-label={`Previous: ${previousItem.label}`}
                >
                  <ChevronLeft aria-hidden="true" />
                  <span>Previous</span>
                </Link>
              ) : (
                <span className="disabled">
                  <ChevronLeft aria-hidden="true" />
                  <span>Previous</span>
                </span>
              )}
              {positionLabel ? (
                <span className="detail-position">{positionLabel}</span>
              ) : null}
              {nextItem ? (
                <Link
                  href={nextItem.href}
                  aria-label={`Next: ${nextItem.label}`}
                >
                  <span>Next</span>
                  <ChevronRight aria-hidden="true" />
                </Link>
              ) : (
                <span className="disabled">
                  <span>Next</span>
                  <ChevronRight aria-hidden="true" />
                </span>
              )}
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
                <LinkButtons links={detail.linkButtons} variant="context" />
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
                    {primaryActions.map((action) => (
                      <ActionTrigger
                        key={action.value}
                        detail={detail}
                        action={action}
                        variant="primary"
                        active={activeActionValue === action.value}
                        onActivate={() =>
                          setActiveActionValue((current) =>
                            current === action.value ? null : action.value
                          )
                        }
                        onMutation={onMutation}
                      />
                    ))}
                  </div>
                  {secondaryActions.length === 1 ? (
                    <div className="secondary-direct">
                      <ActionTrigger
                        detail={detail}
                        action={secondaryActions[0]}
                        variant="overflow"
                        active={activeActionValue === secondaryActions[0].value}
                        onActivate={() =>
                          setActiveActionValue((current) =>
                            current === secondaryActions[0].value
                              ? null
                              : secondaryActions[0].value
                          )
                        }
                        onMutation={onMutation}
                      />
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
                          {secondaryActions.map((action) => (
                            <ActionTrigger
                              key={action.value}
                              detail={detail}
                              action={action}
                              variant="overflow"
                              active={activeActionValue === action.value}
                              onActivate={() =>
                                setActiveActionValue((current) =>
                                  current === action.value ? null : action.value
                                )
                              }
                              onMutation={onMutation}
                            />
                          ))}
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
