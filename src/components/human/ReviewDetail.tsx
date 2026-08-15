"use client";

import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
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
import { ActionComposer, ActionTrigger, UndoAnswerForm } from "./ActionForms";
import { formatReviewPriority, formatUtcTimestamp } from "./review-format";
import { CardVisual, HumanIcon, LinkButtons, SafeHtml } from "./TypedContent";

export function ReviewDetail({
  detail,
  view,
  positionLabel,
  previousItem,
  nextItem,
  resizeHandle
}: {
  detail: HumanReviewDetailDto | null;
  view: HumanReviewView;
  positionLabel: string | null;
  previousItem: { href: string; label: string } | null;
  nextItem: { href: string; label: string } | null;
  resizeHandle?: ReactNode;
}) {
  const [activeActionValue, setActiveActionValue] = useState<string | null>(
    null
  );

  if (!detail) {
    return (
      <section className="detail-pane empty-state">
        {resizeHandle}
        <span className="empty-state-icon">
          <CircleDot aria-hidden="true" />
        </span>
        <h2>Choose a review</h2>
        <p>Select an item from the queue to see its context and respond.</p>
      </section>
    );
  }

  const primaryActions = detail.actions
    .filter((action) => !action.overflow)
    .slice(0, 2);
  const secondaryActions = detail.actions.filter(
    (action) => action.overflow || !primaryActions.includes(action)
  );
  const showActions = detail.status === "pending" && detail.actions.length > 0;
  const activeAction = detail.actions.find(
    (action) => action.value === activeActionValue
  );

  return (
    <section className="detail-pane" aria-label="Review detail">
      {resizeHandle}
      <div className="detail-scroll">
        <div className="detail-topbar">
          <a className="mobile-back" href={humanReviewHref(view)}>
            <ArrowLeft className="back-arrow" aria-hidden="true" />
            <X className="close-icon" aria-hidden="true" />
            <span className="back-copy">Back to queue</span>
            <span className="close-copy">Close detail</span>
          </a>
          <nav className="detail-stepper" aria-label="Review navigation">
            {positionLabel ? (
              <span className="detail-position">{positionLabel}</span>
            ) : null}
            <div className="detail-stepper-buttons">
              {previousItem ? (
                <a
                  href={previousItem.href}
                  aria-label={`Previous: ${previousItem.label}`}
                >
                  <ChevronLeft aria-hidden="true" />
                  <span>Previous</span>
                </a>
              ) : (
                <span className="disabled">
                  <ChevronLeft aria-hidden="true" />
                  <span>Previous</span>
                </span>
              )}
              {nextItem ? (
                <a href={nextItem.href} aria-label={`Next: ${nextItem.label}`}>
                  <span>Next</span>
                  <ChevronRight aria-hidden="true" />
                </a>
              ) : (
                <span className="disabled">
                  <span>Next</span>
                  <ChevronRight aria-hidden="true" />
                </span>
              )}
            </div>
          </nav>
        </div>

        <header className="detail-header">
          <div className="detail-heading-copy">
            <p className="detail-kicker">
              <HumanIcon name={detail.rowType.icon} />
              <span>{detail.rowType.display}</span>
              <span aria-hidden="true">·</span>
              <span>{detail.caller.displayName}</span>
            </p>
            <SafeHtml html={detail.titleHtml} className="detail-title" />
            <SafeHtml html={detail.subtitleHtml} className="detail-subtitle" />
          </div>
        </header>

        <div className="detail-meta">
          <span className={`priority priority-${detail.priority}`}>
            {formatReviewPriority(detail.priority)}
          </span>
          <span className={`detail-risk risk-${reviewRisk(detail)}`}>
            {formatReviewRisk(reviewRisk(detail))}
          </span>
          <CardVisual visual={detail.cardVisual} />
          <span className={`detail-status status-${detail.status}`}>
            {detail.status}
          </span>
          <span className="detail-revision">Rev {detail.currentRevision}</span>
          {detail.output ? (
            <span>
              Answered {detail.output.actionValue}
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
            <SafeHtml html={detail.summaryHtml} className="detail-summary" />
          </section>
          {detail.detailsHtml ? (
            <section>
              <p className="detail-section-label">Context and evidence</p>
              <SafeHtml html={detail.detailsHtml} className="detail-body" />
            </section>
          ) : null}
        </article>

        <LinkButtons links={detail.linkButtons} />

        {detail.output ? (
          <div className="answered-state" aria-label="Answered state">
            <span className="answered-icon">
              <Check aria-hidden="true" />
            </span>
            <div>
              <strong>Answered with {detail.output.actionValue}</strong>
              <span>{formatUtcTimestamp(detail.output.answeredAt)}</span>
            </div>
            <UndoAnswerForm detail={detail} />
          </div>
        ) : null}
      </div>

      <div className="action-section">
        <header>
          <div>
            <span className="response-label">Your response</span>
          </div>
        </header>
        {!showActions ? (
          <p className="muted">This review has no pending actions.</p>
        ) : (
          <>
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
                      />
                    ))}
                  </div>
                </details>
              </div>
            ) : null}
          </>
        )}
        {activeAction && activeAction.popupKind !== "none" ? (
          <ActionComposer
            detail={detail}
            action={activeAction}
            onCancel={() => setActiveActionValue(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function reviewRisk(detail: HumanReviewDetailDto) {
  const payload = detail.cardVisual?.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const value = payload.queue_risk;
    if (value === "high" || value === "medium" || value === "low") {
      return value;
    }
  }
  return "medium";
}

function formatReviewRisk(value: "high" | "medium" | "low") {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)} risk`;
}
