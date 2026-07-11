import type { HumanReviewListRow } from "../../server/human-review.ts";
import type { HumanReviewView } from "./ReviewWorkspace";
import { AccentRail, CardVisual, HumanIcon, SafeHtml } from "./TypedContent";

export function ReviewList({
  rows,
  selectedId,
  selectedIds,
  skippedIds,
  onSelectedChange,
  onSkipToggle,
  view
}: {
  rows: HumanReviewListRow[];
  selectedId: string | null;
  selectedIds: Set<string>;
  skippedIds: Set<string>;
  onSelectedChange: (inputItemId: string, selected: boolean) => void;
  onSkipToggle: (inputItemId: string) => void;
  view: HumanReviewView;
}) {
  if (rows.length === 0) {
    return (
      <section className="empty-state">
        <h2>No matching reviews</h2>
        <p>Adjust the filter or search terms to see more queue items.</p>
      </section>
    );
  }

  return (
    <ol className="review-list" aria-label="Review queue">
      {rows.map((row) => (
        <li key={row.inputItemId}>
          <article
            className={
              row.inputItemId === selectedId
                ? "review-row selected"
                : "review-row"
            }
          >
            <AccentRail color={row.rowAccentColor} />
            <div className="row-main">
              <div className="row-heading">
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
                <span className={`priority priority-${row.priority}`}>
                  {row.priority}
                </span>
                <span className="row-type">
                  <HumanIcon name={row.rowType.icon} />
                  {row.rowType.display}
                </span>
                <span className={`status-pill status-${row.status}`}>
                  {row.status}
                </span>
                {skippedIds.has(row.inputItemId) ? (
                  <span className="status-pill status-skipped">skipped</span>
                ) : null}
              </div>
              <a className="row-link" href={reviewHref(row.inputItemId, view)}>
                <SafeHtml html={row.titleHtml} className="row-title" />
              </a>
              <SafeHtml html={row.subtitleHtml} className="row-subtitle" />
              <div className="row-footer">
                <span>{row.caller.displayName}</span>
                <span>{formatTimestamp(row.updatedAt)}</span>
                {row.output ? (
                  <span>Answered {row.output.actionValue}</span>
                ) : null}
                {row.cornerHtml ? <SafeHtml html={row.cornerHtml} /> : null}
              </div>
              <div className="row-actions">
                <button
                  className="row-tool-button"
                  type="button"
                  disabled={row.skipDisabled}
                  onClick={() => onSkipToggle(row.inputItemId)}
                >
                  {skippedIds.has(row.inputItemId) ? "Unskip" : "Skip"}
                </button>
              </div>
            </div>
            <div className="row-visual">
              <CardVisual visual={row.cardVisual} />
            </div>
          </article>
        </li>
      ))}
    </ol>
  );
}

function reviewHref(inputItemId: string, view: HumanReviewView) {
  const params = new URLSearchParams({ item: inputItemId });
  if (view.search) params.set("search", view.search);
  if (view.status !== "all") params.set("status", view.status);
  if (view.sort !== "priority") params.set("sort", view.sort);
  if (view.page !== 1) params.set("page", String(view.page));
  return `/human?${params.toString()}`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC"
  }).format(new Date(value));
}
