"use client";

import { useEffect, useMemo, useState } from "react";

import type { HumanAccountSession } from "../../server/human-session.ts";
import type {
  HumanReviewDetail,
  HumanReviewListRow
} from "../../server/human-review.ts";
import type { AccountStatusData, StatusResult } from "../../server/status.ts";
import { AccountBanner } from "./AccountBanner";
import { BulkActions } from "./BulkActions";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewList } from "./ReviewList";

type ReviewStatusFilter = "all" | "pending" | "answered";
type ReviewSort = "priority" | "updated_at";
type PersistedWorkspaceState = {
  search?: unknown;
  status?: unknown;
  sort?: unknown;
  skippedIds?: unknown;
};

const WORKSPACE_STATE_KEY = "agent-outbox:human-review-workspace:v1";

export type HumanReviewNotice = {
  kind: "notice" | "error";
  message: string;
};

export function ReviewWorkspace({
  session,
  rows,
  detail,
  banner,
  notice
}: {
  session: HumanAccountSession;
  rows: HumanReviewListRow[];
  detail: HumanReviewDetail | null;
  banner: StatusResult<AccountStatusData>;
  notice: HumanReviewNotice | null;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ReviewStatusFilter>("all");
  const [sort, setSort] = useState<ReviewSort>("priority");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const persisted = readWorkspaceState();
    if (persisted) {
      setSearch(persisted.search);
      setStatus(persisted.status);
      setSort(persisted.sort);
      setSkippedIds(new Set(persisted.skippedIds));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    writeWorkspaceState({
      search,
      status,
      sort,
      skippedIds: [...skippedIds]
    });
  }, [hydrated, search, skippedIds, sort, status]);

  const visibleRows = useMemo(() => {
    const terms = search.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const statusMatches = status === "all" || row.status === status;
      const searchMatches =
        !terms ||
        [
          stripHtml(row.titleHtml),
          stripHtml(row.subtitleHtml),
          stripHtml(row.summaryHtml),
          row.caller.displayName,
          row.callerItemId,
          row.rowType.display
        ]
          .join(" ")
          .toLowerCase()
          .includes(terms);
      return statusMatches && searchMatches;
    });

    return [...filtered].sort((left, right) => {
      const leftSkipped = skippedIds.has(left.inputItemId);
      const rightSkipped = skippedIds.has(right.inputItemId);
      if (leftSkipped !== rightSkipped) {
        return leftSkipped ? 1 : -1;
      }
      if (sort === "priority") {
        const priority =
          priorityWeight(left.priority) - priorityWeight(right.priority);
        if (priority !== 0) {
          return priority;
        }
      }
      return (
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    });
  }, [rows, search, skippedIds, sort, status]);
  const selectedRows = useMemo(
    () => visibleRows.filter((row) => selectedIds.has(row.inputItemId)),
    [selectedIds, visibleRows]
  );

  function setRowSelected(inputItemId: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(inputItemId);
      } else {
        next.delete(inputItemId);
      }
      return next;
    });
  }

  function toggleSkipped(inputItemId: string) {
    setSkippedIds((current) => {
      const next = new Set(current);
      if (next.has(inputItemId)) {
        next.delete(inputItemId);
      } else {
        next.add(inputItemId);
      }
      return next;
    });
  }

  return (
    <main className="human-workspace">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Human review</p>
          <h1>Review queue</h1>
          <p>
            Signed in as owner of{" "}
            <span data-testid="fixture-account-id">
              {session.account.accountId}
            </span>
            .
          </p>
        </div>
        <div className="session-card" data-testid="owner-membership">
          <span>Owner membership</span>
          <strong>{session.userId}</strong>
          <span>
            Provisioned on this request:{" "}
            <b data-testid="provisioned-account">
              {session.provisionedAccount ? "yes" : "no"}
            </b>
          </span>
        </div>
      </section>

      <AccountBanner banner={banner} />
      {notice ? (
        <section className={`human-notice ${notice.kind}`} role="status">
          {notice.message}
        </section>
      ) : null}

      <section className="review-controls" aria-label="Review controls">
        <span className="sr-only" data-testid="workspace-hydrated">
          {hydrated ? "hydrated" : "loading"}
        </span>
        <label>
          <span>Search</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search reviews"
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as ReviewStatusFilter)
            }
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="answered">Answered</option>
          </select>
        </label>
        <label>
          <span>Sort</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as ReviewSort)}
          >
            <option value="priority">Priority</option>
            <option value="updated_at">Updated</option>
          </select>
        </label>
      </section>

      <BulkActions selectedRows={selectedRows} />

      <div className="review-shell">
        <ReviewList
          rows={visibleRows}
          selectedId={detail?.inputItemId ?? null}
          selectedIds={selectedIds}
          skippedIds={skippedIds}
          onSelectedChange={setRowSelected}
          onSkipToggle={toggleSkipped}
        />
        <ReviewDetail detail={detail} />
      </div>
    </main>
  );
}

function priorityWeight(priority: HumanReviewListRow["priority"]) {
  return { urgent: 0, high: 1, normal: 2, low: 3 }[priority];
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ");
}

function readWorkspaceState(): {
  search: string;
  status: ReviewStatusFilter;
  sort: ReviewSort;
  skippedIds: string[];
} | null {
  try {
    const raw = window.sessionStorage.getItem(WORKSPACE_STATE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PersistedWorkspaceState;
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      status:
        parsed.status === "all" ||
        parsed.status === "pending" ||
        parsed.status === "answered"
          ? parsed.status
          : "all",
      sort:
        parsed.sort === "priority" || parsed.sort === "updated_at"
          ? parsed.sort
          : "priority",
      skippedIds: Array.isArray(parsed.skippedIds)
        ? parsed.skippedIds.filter((id): id is string => typeof id === "string")
        : []
    };
  } catch {
    return null;
  }
}

function writeWorkspaceState(state: {
  search: string;
  status: ReviewStatusFilter;
  sort: ReviewSort;
  skippedIds: string[];
}) {
  try {
    window.sessionStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Browsers can disable session storage; the queue still works with defaults.
  }
}
