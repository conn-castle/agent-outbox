"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  ListChecks,
  Search,
  SlidersHorizontal,
  X
} from "lucide-react";

import type { HumanAccountSession } from "../../server/human-session.ts";
import type {
  HumanReviewDetail,
  HumanReviewListRow
} from "../../server/human-review.ts";
import type { AccountStatusData, StatusResult } from "../../server/status.ts";
import {
  humanReviewHref,
  humanReviewViewFromSearchParams,
  writeHumanReviewView,
  type HumanReviewView
} from "../../shared/human-review-view";
import { AccountBanner } from "./AccountBanner";
import { UndoNoticeForm } from "./ActionForms";
import { BulkActions } from "./BulkActions";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewList } from "./ReviewList";

type PersistedWorkspaceState = {
  selectedIds?: unknown;
  skippedIds?: unknown;
};

type WorkspaceLayout = {
  detailWidth: number;
};

type DetailResize = {
  pointerId: number;
  startX: number;
  startWidth: number;
};

const WORKSPACE_STATE_KEY_PREFIX = "agent-outbox:human-review-workspace:v1";
const WORKSPACE_LAYOUT_KEY_PREFIX = "agent-outbox:human-review-layout:v5";
const WORKSPACE_ID_LIMIT = 100;
const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  detailWidth: 440
};
const DETAIL_MIN_WIDTH = 380;
const DETAIL_MAX_WIDTH = 640;

export type HumanReviewNotice = {
  kind: "notice" | "error";
  message: string;
  failedActionKind?: "file_upload";
  undo?: {
    inputItemId: string;
    callerId: string;
    outputResultId: string;
  };
};

export function ReviewWorkspace({
  session,
  rows,
  detail,
  banner,
  notice,
  view,
  hasNext,
  detailOpen,
  renderedAt
}: {
  session: HumanAccountSession;
  rows: HumanReviewListRow[];
  detail: HumanReviewDetail | null;
  banner: StatusResult<AccountStatusData>;
  notice: HumanReviewNotice | null;
  view: HumanReviewView;
  hasNext: boolean;
  detailOpen: boolean;
  renderedAt: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(view.search);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [layout, setLayout] = useState<WorkspaceLayout>(
    DEFAULT_WORKSPACE_LAYOUT
  );
  const [hydratedAccountId, setHydratedAccountId] = useState<string | null>(
    null
  );
  const [layoutHydratedAccountId, setLayoutHydratedAccountId] = useState<
    string | null
  >(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailResizeRef = useRef<DetailResize | null>(null);

  useEffect(() => {
    const persisted = readWorkspaceState(session.accountId);
    setSelectedIds(new Set(persisted?.selectedIds ?? []));
    setSkippedIds(new Set(persisted?.skippedIds ?? []));
    setSelectionMode((persisted?.selectedIds.length ?? 0) > 0);
    setHydratedAccountId(session.accountId);
  }, [session.accountId]);

  useEffect(() => {
    setLayout(readWorkspaceLayout(session.accountId));
    setLayoutHydratedAccountId(session.accountId);
  }, [session.accountId]);

  useEffect(() => {
    if (hydratedAccountId !== session.accountId) {
      return;
    }
    writeWorkspaceState(session.accountId, {
      selectedIds: [...selectedIds],
      skippedIds: [...skippedIds]
    });
  }, [hydratedAccountId, selectedIds, session.accountId, skippedIds]);

  useEffect(() => {
    if (layoutHydratedAccountId !== session.accountId) {
      return;
    }
    writeWorkspaceLayout(session.accountId, layout);
  }, [layout, layoutHydratedAccountId, session.accountId]);

  useEffect(() => {
    const visibleNonPendingIds = new Set(
      rows
        .filter((row) => row.status !== "pending")
        .map((row) => row.inputItemId)
    );
    if (visibleNonPendingIds.size === 0) {
      return;
    }
    setSelectedIds((current) => removeIds(current, visibleNonPendingIds));
  }, [rows]);

  useEffect(() => {
    // Re-sync the input after navigation (back/forward, action redirects).
    // Skip while a debounced edit is pending so in-flight typing survives.
    if (searchTimer.current === null) {
      setSearch(view.search);
    }
  }, [view.search]);

  useEffect(() => {
    setNoticeDismissed(false);
  }, [notice?.message]);

  function updateView(changes: Partial<HumanReviewView>) {
    const params = new URLSearchParams(window.location.search);
    params.delete("item");
    params.delete("error");
    params.delete("failedActionKind");
    params.delete("notice");
    params.delete("action");
    params.delete("answered");
    params.delete("failed");
    params.delete("undo_target");
    params.delete("undo_actor");
    params.delete("undo_result");
    params.delete("resolved");
    params.delete("subject");
    // Seed from the URL, not the `view` prop: the prop lags router.replace
    // until the server round-trip completes, so rapid successive control
    // changes would silently revert earlier ones.
    const next = { ...humanReviewViewFromSearchParams(params), ...changes };
    writeHumanReviewView(params, next);
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
  const pendingCount = rows.filter((row) => row.status === "pending").length;
  const detailIndex = detail
    ? visibleRows.findIndex((row) => row.inputItemId === detail.inputItemId)
    : -1;
  const previousDetailRow =
    detailIndex > 0 ? visibleRows[detailIndex - 1] : null;
  const nextDetailRow =
    detailIndex >= 0 && detailIndex < visibleRows.length - 1
      ? visibleRows[detailIndex + 1]
      : null;

  function setRowSelected(inputItemId: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) {
        addBoundedId(next, inputItemId);
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
        addBoundedId(next, inputItemId);
      }
      return next;
    });
  }

  function toggleSelectionMode() {
    if (selectionMode) {
      setSelectedIds(new Set());
    }
    setSelectionMode((current) => !current);
  }

  function moveQueueFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("input, select, textarea, button, summary")
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (
      key !== "j" &&
      key !== "k" &&
      key !== "arrowdown" &&
      key !== "arrowup"
    ) {
      return;
    }
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(".review-list .row-link")
    ];
    if (links.length === 0) return;
    const activeIndex = links.findIndex(
      (link) => link === document.activeElement
    );
    const moveForward = key === "j" || key === "arrowdown";
    const nextIndex =
      activeIndex < 0
        ? moveForward
          ? 0
          : links.length - 1
        : clamp(activeIndex + (moveForward ? 1 : -1), 0, links.length - 1);
    event.preventDefault();
    links[nextIndex]?.focus();
  }

  function startDetailResize(event: PointerEvent<HTMLButtonElement>) {
    detailResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: layout.detailWidth
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDetailResize(event: PointerEvent<HTMLButtonElement>) {
    const resize = detailResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setLayout((current) => ({
      ...current,
      detailWidth: clamp(
        resize.startWidth + resize.startX - event.clientX,
        DETAIL_MIN_WIDTH,
        Math.min(DETAIL_MAX_WIDTH, window.innerWidth - 320)
      )
    }));
  }

  function finishDetailResize(event: PointerEvent<HTMLButtonElement>) {
    if (detailResizeRef.current?.pointerId !== event.pointerId) return;
    detailResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeDetailWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? 16 : -16;
    setLayout((current) => ({
      ...current,
      detailWidth: clamp(
        current.detailWidth + delta,
        DETAIL_MIN_WIDTH,
        DETAIL_MAX_WIDTH
      )
    }));
  }

  const workspaceStyle = {
    "--detail-pane-width": `${layout.detailWidth}px`
  } as CSSProperties;

  return (
    <main
      className="human-workspace"
      style={workspaceStyle}
      onKeyDown={moveQueueFocus}
    >
      <header className="app-bar">
        <a className="app-brand" href="/human" aria-label="Agent Outbox home">
          <img src="/agent-outbox-mark.svg" alt="" width="36" height="36" />
          <span>
            Agent <b>Outbox</b>
          </span>
        </a>
        <div className="app-location" aria-label="Current workspace">
          Review queue
        </div>
        <div className="app-account">
          <AccountBanner banner={banner} />
          <a className="app-sign-out" href="/sign-out">
            Sign out
          </a>
          <span className="sr-only" data-testid="fixture-account-id">
            {session.account.accountId}
          </span>
          <span className="sr-only" data-testid="owner-membership">
            <strong>{session.userId}</strong>
            <b data-testid="provisioned-account">
              {session.provisionedAccount ? "yes" : "no"}
            </b>
          </span>
        </div>
      </header>

      {notice && !noticeDismissed ? (
        <div className={`human-notice ${notice.kind}`} role="status">
          <div className="notice-copy">
            <strong>{notice.message}</strong>
            {notice.undo ? (
              <span>
                Undo remains available until the agent receives this decision.
              </span>
            ) : null}
          </div>
          <div className="notice-actions">
            {notice.undo ? <UndoNoticeForm {...notice.undo} /> : null}
            <button
              className="notice-dismiss"
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setNoticeDismissed(true)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={detailOpen ? "workspace-body" : "workspace-body queue-only"}
      >
        <section
          className={`queue-pane${view.page > 1 || hasNext ? " paginated" : ""}`}
          aria-label="Queue browser"
        >
          <header className="queue-header">
            <div className="queue-heading">
              <h2>
                {view.status === "all"
                  ? "All reviews"
                  : `${capitalize(view.status)} reviews`}
              </h2>
              <div className="queue-count" aria-label="Current view summary">
                <strong>
                  {pendingCount}
                  {hasNext ? "+" : ""}
                </strong>
                <span>pending</span>
              </div>
              <span
                className="queue-heading-shortcuts"
                aria-label="Keyboard shortcuts"
              >
                <kbd>J</kbd>
                <kbd>K</kbd>
                <span>move</span>
              </span>
            </div>
            <button
              className="mobile-tools-button"
              type="button"
              aria-label="Review tools"
              aria-expanded={mobileToolsOpen}
              aria-controls="review-controls"
              title={mobileToolsOpen ? "Close filters" : "Search and filter"}
              onClick={() => setMobileToolsOpen((current) => !current)}
            >
              {mobileToolsOpen ? (
                <X aria-hidden="true" />
              ) : (
                <Filter aria-hidden="true" />
              )}
              <span className="mobile-tools-state">
                {mobileToolsOpen
                  ? "Close filters"
                  : `Search · ${capitalize(view.status)} · ${
                      view.sort === "priority" ? "Priority" : "Newest"
                    }`}
              </span>
              <span className="mobile-tools-copy">
                {mobileToolsOpen
                  ? "Close filters"
                  : `Search · ${capitalize(view.status)} · ${
                      view.sort === "priority" ? "Priority" : "Newest"
                    }`}
              </span>
            </button>
            <button
              className={
                selectionMode
                  ? "compact-selection-button active"
                  : "compact-selection-button"
              }
              type="button"
              aria-label={selectionMode ? "Done selecting" : "Select items"}
              aria-pressed={selectionMode}
              onClick={toggleSelectionMode}
            >
              <ListChecks aria-hidden="true" />
              <span>{selectionMode ? "Done" : "Select"}</span>
            </button>
            <section
              id="review-controls"
              className={`review-controls${mobileToolsOpen ? " open" : ""}`}
              aria-label="Review controls"
            >
              <span className="sr-only" data-testid="workspace-hydrated">
                {hydratedAccountId === session.accountId
                  ? "hydrated"
                  : "loading"}
              </span>
              <form
                className="review-search"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitSearch();
                }}
              >
                <button type="submit">
                  <span className="sr-only">Search</span>
                  <Search aria-hidden="true" />
                </button>
                <label>
                  <span className="sr-only">Search</span>
                  <input
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      applyDebouncedSearch(event.target.value);
                    }}
                    placeholder="Search reviews"
                  />
                </label>
              </form>
              <div className="filter-controls">
                <SlidersHorizontal aria-hidden="true" />
                <label>
                  <span className="control-label">Status</span>
                  <select
                    aria-label="Status"
                    value={view.status}
                    onChange={(event) =>
                      updateViewImmediately({
                        status: event.target.value as HumanReviewView["status"],
                        page: 1
                      })
                    }
                  >
                    <option value="all">Status: All</option>
                    <option value="pending">Status: Pending</option>
                    <option value="answered">Status: Answered</option>
                  </select>
                </label>
                <label>
                  <span className="control-label">Sort</span>
                  <select
                    aria-label="Sort"
                    value={view.sort}
                    onChange={(event) =>
                      updateViewImmediately({
                        sort: event.target.value as HumanReviewView["sort"],
                        page: 1
                      })
                    }
                  >
                    <option value="priority">Sort: Priority</option>
                    <option value="updated_at">Sort: Recent</option>
                  </select>
                </label>
              </div>
              <button
                className={
                  selectionMode
                    ? "selection-mode-button active"
                    : "selection-mode-button"
                }
                type="button"
                aria-pressed={selectionMode}
                onClick={toggleSelectionMode}
              >
                <ListChecks aria-hidden="true" />
                <span className="selection-copy-wide">
                  {selectionMode ? "Done selecting" : "Select items"}
                </span>
                <span className="selection-copy-mobile">
                  {selectionMode ? "Done" : "Select items"}
                </span>
              </button>
            </section>
          </header>

          <BulkActions
            selectedRows={selectedRows}
            offPageSelectedCount={offPageSelectedCount}
          />

          <div className="queue-scroll">
            <ReviewList
              rows={visibleRows}
              selectedId={detail?.inputItemId ?? null}
              selectedIds={selectedIds}
              skippedIds={skippedIds}
              onSelectedChange={setRowSelected}
              onSkipToggle={toggleSkipped}
              selectionMode={selectionMode}
              view={view}
              renderedAt={renderedAt}
            />
            {!hasNext && visibleRows.length > 0 ? (
              <div className="queue-end">
                <span>End of queue</span>
                <span className="queue-keyboard-hint">
                  <kbd>J</kbd>
                  <kbd>K</kbd> move · <kbd>Enter</kbd> open
                </span>
                <a
                  href={humanReviewHref({
                    ...view,
                    search: "",
                    status: "answered",
                    page: 1
                  })}
                >
                  Review answered decisions
                </a>
              </div>
            ) : null}
          </div>

          {view.page > 1 || hasNext ? (
            <nav className="review-pagination" aria-label="Review pages">
              <button
                type="button"
                aria-label="Previous 100"
                disabled={view.page <= 1}
                onClick={() => updateViewImmediately({ page: view.page - 1 })}
              >
                <ChevronLeft aria-hidden="true" />
                <span>Previous page</span>
              </button>
              <span>
                {visibleRows.length > 0
                  ? `Items ${(view.page - 1) * 100 + 1}–${
                      (view.page - 1) * 100 + visibleRows.length
                    }`
                  : "No items"}
              </span>
              <button
                type="button"
                aria-label="Next 100"
                disabled={!hasNext}
                onClick={() => updateViewImmediately({ page: view.page + 1 })}
              >
                <span>Next page</span>
                <ChevronRight aria-hidden="true" />
              </button>
            </nav>
          ) : null}
        </section>

        {detailOpen ? (
          <ReviewDetail
            key={detail?.inputItemId ?? "empty"}
            detail={detail}
            view={view}
            positionLabel={
              detailIndex >= 0
                ? `${detailIndex + 1} of ${visibleRows.length}`
                : null
            }
            previousItem={
              previousDetailRow
                ? {
                    href: humanReviewHref(view, previousDetailRow.inputItemId),
                    label: plainText(previousDetailRow.titleHtml)
                  }
                : null
            }
            nextItem={
              nextDetailRow
                ? {
                    href: humanReviewHref(view, nextDetailRow.inputItemId),
                    label: plainText(nextDetailRow.titleHtml)
                  }
                : null
            }
            resizeHandle={
              <button
                className="detail-resize-handle"
                type="button"
                role="separator"
                aria-label="Resize review detail panel"
                aria-orientation="vertical"
                aria-valuemin={DETAIL_MIN_WIDTH}
                aria-valuemax={DETAIL_MAX_WIDTH}
                aria-valuenow={Math.round(layout.detailWidth)}
                title="Drag to resize detail panel"
                onDoubleClick={() =>
                  setLayout((current) => ({
                    ...current,
                    detailWidth: DEFAULT_WORKSPACE_LAYOUT.detailWidth
                  }))
                }
                onPointerDown={startDetailResize}
                onPointerMove={moveDetailResize}
                onPointerUp={finishDetailResize}
                onPointerCancel={finishDetailResize}
                onKeyDown={resizeDetailWithKeyboard}
              />
            }
          />
        ) : null}
      </div>
    </main>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function workspaceStateKey(accountId: string) {
  return `${WORKSPACE_STATE_KEY_PREFIX}:${accountId}`;
}

function readWorkspaceState(accountId: string): {
  selectedIds: string[];
  skippedIds: string[];
} | null {
  try {
    const raw = window.sessionStorage.getItem(workspaceStateKey(accountId));
    if (!raw) {
      return null;
    }

    const parsedJson: unknown = JSON.parse(raw);
    if (
      parsedJson === null ||
      typeof parsedJson !== "object" ||
      Array.isArray(parsedJson)
    ) {
      return null;
    }
    const parsed = parsedJson as Partial<PersistedWorkspaceState>;
    return {
      selectedIds: Array.isArray(parsed.selectedIds)
        ? boundedStringIds(parsed.selectedIds)
        : [],
      skippedIds: Array.isArray(parsed.skippedIds)
        ? boundedStringIds(parsed.skippedIds)
        : []
    };
  } catch {
    return null;
  }
}

function writeWorkspaceState(
  accountId: string,
  state: {
    selectedIds: string[];
    skippedIds: string[];
  }
) {
  try {
    window.sessionStorage.setItem(
      workspaceStateKey(accountId),
      JSON.stringify({
        selectedIds: boundedStringIds(state.selectedIds),
        skippedIds: boundedStringIds(state.skippedIds)
      })
    );
  } catch {
    // Browsers can disable session storage; the queue still works with defaults.
  }
}

function workspaceLayoutKey(accountId: string) {
  return `${WORKSPACE_LAYOUT_KEY_PREFIX}:${accountId}`;
}

function readWorkspaceLayout(accountId: string): WorkspaceLayout {
  try {
    const raw = window.localStorage.getItem(workspaceLayoutKey(accountId));
    if (!raw) return DEFAULT_WORKSPACE_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return DEFAULT_WORKSPACE_LAYOUT;
    }
    const candidate = parsed as Partial<WorkspaceLayout>;
    if (
      typeof candidate.detailWidth !== "number" ||
      !Number.isFinite(candidate.detailWidth)
    ) {
      return DEFAULT_WORKSPACE_LAYOUT;
    }
    return {
      detailWidth: clamp(
        candidate.detailWidth,
        DETAIL_MIN_WIDTH,
        DETAIL_MAX_WIDTH
      )
    };
  } catch {
    return DEFAULT_WORKSPACE_LAYOUT;
  }
}

function writeWorkspaceLayout(accountId: string, layout: WorkspaceLayout) {
  try {
    window.localStorage.setItem(
      workspaceLayoutKey(accountId),
      JSON.stringify(layout)
    );
  } catch {
    // Browsers can disable local storage; resizing still works for this view.
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function boundedStringIds(values: unknown[]) {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string")
    )
  ].slice(-WORKSPACE_ID_LIMIT);
}

function addBoundedId(ids: Set<string>, id: string) {
  ids.delete(id);
  ids.add(id);
  while (ids.size > WORKSPACE_ID_LIMIT) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}

function removeIds(ids: Set<string>, removals: Set<string>) {
  if (![...removals].some((id) => ids.has(id))) {
    return ids;
  }
  const next = new Set(ids);
  for (const id of removals) next.delete(id);
  return next;
}

function plainText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
