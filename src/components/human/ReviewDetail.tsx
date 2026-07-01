import type { HumanReviewDetail as HumanReviewDetailDto } from "../../server/human-review.ts";
import { ActionForm, UndoAnswerForm } from "./ActionForms";
import {
  CardVisual,
  HumanIcon,
  LinkButtons,
  PopupMetadata,
  SafeHtml
} from "./TypedContent";

export function ReviewDetail({
  detail
}: {
  detail: HumanReviewDetailDto | null;
}) {
  if (!detail) {
    return (
      <section className="detail-pane empty-state">
        <h2>Select a review</h2>
        <p>The detail pane loads one queue item at a time.</p>
      </section>
    );
  }

  const primaryActions = detail.actions.filter((action) => !action.overflow);
  const overflowActions = detail.actions.filter((action) => action.overflow);
  const showActions = detail.status === "pending" && detail.actions.length > 0;

  return (
    <section className="detail-pane" aria-label="Review detail">
      <div className="detail-header">
        <div>
          <p className="detail-kicker">
            <HumanIcon name={detail.rowType.icon} />
            {detail.rowType.display} · {detail.caller.displayName}
          </p>
          <SafeHtml html={detail.titleHtml} className="detail-title" />
          <SafeHtml html={detail.subtitleHtml} className="detail-subtitle" />
        </div>
        <CardVisual visual={detail.cardVisual} />
      </div>

      <div className="detail-meta">
        <span>Revision {detail.currentRevision}</span>
        <span>{detail.priority} priority</span>
        <span>{detail.status}</span>
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

      <SafeHtml html={detail.summaryHtml} className="detail-summary" />
      {detail.detailsHtml ? (
        <SafeHtml html={detail.detailsHtml} className="detail-body" />
      ) : null}

      <LinkButtons links={detail.linkButtons} />

      {detail.output ? (
        <div className="answered-state" aria-label="Answered state">
          <div>
            <strong>Answered with {detail.output.actionValue}</strong>
            <span>{formatTimestamp(detail.output.answeredAt)}</span>
          </div>
          <UndoAnswerForm detail={detail} />
        </div>
      ) : null}

      <div className="action-section">
        <h2>Actions</h2>
        {!showActions ? (
          <p className="muted">No pending actions are available.</p>
        ) : (
          <>
            <div className="primary-actions">
              {primaryActions.map((action) => (
                <ActionForm
                  key={action.value}
                  detail={detail}
                  action={action}
                  variant="primary"
                />
              ))}
            </div>
            <div className="overflow-actions">
              {overflowActions.map((action) => (
                <ActionForm
                  key={action.value}
                  detail={detail}
                  action={action}
                  variant="overflow"
                />
              ))}
            </div>
            <div className="popup-list">
              {detail.actions.map((action) => (
                <div key={action.value} className="popup-row">
                  <strong>{action.display}</strong>
                  <PopupMetadata action={action} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value));
}
