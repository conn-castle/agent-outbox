"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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

export type HumanReviewView = {
  search: string;
  status: "all" | "pending" | "answered";
  sort: "priority" | "updated_at";
  page: number;
};
type PersistedWorkspaceState = {
  selectedIds?: unknown;
  skippedIds?: unknown;
};

const WORKSPACE_STATE_KEY = "agent-outbox:human-review-workspace:v1";

export type HumanReviewNotice = {
  kind: "notice" | "error";
  message: string;
  failedActionKind?: "file_upload";
};

export function ReviewWorkspace({
  session,
  rows,
  detail,
  banner,
  notice,
  view,
  hasNext
}: {
  session: HumanAccountSession;
  rows: HumanReviewListRow[];
  detail: HumanReviewDetail | null;
  banner: StatusResult<AccountStatusData>;
  notice: HumanReviewNotice | null;
  view: HumanReviewView;
  hasNext: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(view.search);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const persisted = readWorkspaceState();
    if (persisted) {
      setSelectedIds(new Set(persisted.selectedIds));
      setSkippedIds(new Set(persisted.skippedIds));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    writeWorkspaceState({
      selectedIds: [...selectedIds],
      skippedIds: [...skippedIds]
    });
  }, [hydrated, selectedIds, skippedIds]);

  useEffect(() => {
    // Re-sync the input after navigation (back/forward, action redirects).
    // Skip while a debounced edit is pending so in-flight typing survives.
    if (searchTimer.current === null) {
      setSearch(view.search);
    }
  }, [view.search]);

  function updateView(changes: Partial<HumanReviewView>) {
    const params = new URLSearchParams(window.location.search);
    params.delete("item");
    params.delete("error");
    params.delete("failedActionKind");
    params.delete("notice");
    params.delete("action");
    params.delete("answered");
    params.delete("failed");
    // Seed from the URL, not the `view` prop: the prop lags router.replace
    // until the server round-trip completes, so rapid successive control
    // changes would silently revert earlier ones.
    const next = { ...viewFromSearchParams(params), ...changes };
    if (next.search === "") params.delete("search");
    else params.set("search", next.search);
    if (next.status === "all") params.delete("status");
    else params.set("status", next.status);
    if (next.sort === "priority") params.delete("sort");
    else params.set("sort", next.sort);
    if (next.page === 1) params.delete("page");
    else params.set("page", String(next.page));
    const href = `${window.location.pathname}?${params.toString()}`;
    router.replace(href);
  }

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    []
  );

  function cancelDebouncedSearch() {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
  }

  function applyDebouncedSearch(nextSearch: string) {
    cancelDebouncedSearch();
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      updateView({ search: nextSearch, page: 1 });
    }, 300);
  }

  function submitSearch() {
    cancelDebouncedSearch();
    updateView({ search, page: 1 });
  }

  function updateViewImmediately(changes: Partial<HumanReviewView>) {
    cancelDebouncedSearch();
    updateView(
      search === view.search ? changes : { ...changes, search, page: 1 }
    );
  }

  const visibleRows = useMemo(() => {
    return [...rows].sort((left, right) => {
      const leftSkipped = skippedIds.has(left.inputItemId);
      const rightSkipped = skippedIds.has(right.inputItemId);
      if (leftSkipped !== rightSkipped) {
        return leftSkipped ? 1 : -1;
      }
      return 0;
    });
  }, [rows, skippedIds]);
  const selectedRows = useMemo(
    () => visibleRows.filter((row) => selectedIds.has(row.inputItemId)),
    [selectedIds, visibleRows]
  );
  const offPageSelectedCount = useMemo(() => {
    const visibleIds = new Set(rows.map((row) => row.inputItemId));
    let count = 0;
    for (const id of selectedIds) {
      if (!visibleIds.has(id)) {
        count += 1;
      }
    }
    return count;
  }, [rows, selectedIds]);

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
        <form
          className="review-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <label>
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                applyDebouncedSearch(event.target.value);
              }}
              placeholder="Search reviews"
            />
          </label>
          <button className="action-button" type="submit">
            Search
          </button>
        </form>
        <label>
          <span>Status</span>
          <select
            value={view.status}
            onChange={(event) =>
              updateViewImmediately({
                status: event.target.value as HumanReviewView["status"],
                page: 1
              })
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
            value={view.sort}
            onChange={(event) =>
              updateViewImmediately({
                sort: event.target.value as HumanReviewView["sort"],
                page: 1
              })
            }
          >
            <option value="priority">Priority</option>
            <option value="updated_at">Updated</option>
          </select>
        </label>
      </section>

      <BulkActions
        selectedRows={selectedRows}
        offPageSelectedCount={offPageSelectedCount}
      />

      <nav className="review-pagination" aria-label="Review pages">
        {view.page > 1 ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => updateViewImmediately({ page: view.page - 1 })}
          >
            Previous page
          </button>
        ) : null}
        <span>Page {view.page}</span>
        {hasNext ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => updateViewImmediately({ page: view.page + 1 })}
          >
            Next page
          </button>
        ) : null}
      </nav>

      <div className="review-shell">
        <ReviewList
          rows={visibleRows}
          selectedId={detail?.inputItemId ?? null}
          selectedIds={selectedIds}
          skippedIds={skippedIds}
          onSelectedChange={setRowSelected}
          onSkipToggle={toggleSkipped}
          view={view}
        />
        <ReviewDetail detail={detail} />
      </div>
    </main>
  );
}

// Mirrors the server-side `humanReviewView` defaults in app/human/page.tsx.
function viewFromSearchParams(params: URLSearchParams): HumanReviewView {
  const status = params.get("status");
  const sort = params.get("sort");
  const rawPage = params.get("page");
  const parsedPage = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  return {
    search: params.get("search")?.trim() ?? "",
    status: status === "pending" || status === "answered" ? status : "all",
    sort: sort === "updated_at" ? "updated_at" : "priority",
    page: Number.isSafeInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1
  };
}

function readWorkspaceState(): {
  selectedIds: string[];
  skippedIds: string[];
} | null {
  try {
    const raw = window.sessionStorage.getItem(WORKSPACE_STATE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PersistedWorkspaceState;
    return {
      selectedIds: Array.isArray(parsed.selectedIds)
        ? parsed.selectedIds.filter(
            (item): item is string => typeof item === "string"
          )
        : [],
      skippedIds: Array.isArray(parsed.skippedIds)
        ? parsed.skippedIds.filter(
            (item): item is string => typeof item === "string"
          )
        : []
    };
  } catch {
    return null;
  }
}

function writeWorkspaceState(state: {
  selectedIds: string[];
  skippedIds: string[];
}) {
  try {
    window.sessionStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Browsers can disable session storage; the queue still works with defaults.
  }
}
