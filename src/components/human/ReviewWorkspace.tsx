"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  ListChecks,
  Search,
  SlidersHorizontal,
  X
} from "lucide-react";
import { toast } from "sonner";

import { useAppActions } from "../actions/AppActionProvider";
import type { HumanAccountSession } from "../../server/human-session.ts";
import type {
  HumanAccountBannerData,
  HumanReviewDetail,
  HumanReviewListRow
} from "../../server/human-review.ts";
import type { StatusResult } from "../../server/status.ts";
import type { HumanAccountIdentityDisplay } from "../../shared/account-display.ts";
import {
  humanReviewHref,
  humanReviewViewFromSearchParams,
  writeHumanReviewView,
  type HumanReviewView
} from "../../shared/human-review-view";
import { AccountBanner } from "./AccountBanner";
import {
  type HumanMutationSubmission,
  type OnHumanMutation
} from "./ActionForms";
import { BulkActions } from "./BulkActions";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewList } from "./ReviewList";
import {
  HUMAN_MUTATION_SCOPE,
  HumanMutationError,
  isHumanOptimisticMutation,
  synchronizeHumanMutation,
  type HumanOptimisticMutation
} from "./human-mutation-client";

type PersistedWorkspaceState = {
  selectedIds?: unknown;
  skippedIds?: unknown;
};

const WORKSPACE_STATE_KEY_PREFIX = "agent-outbox:human-review-workspace:v1";
const WORKSPACE_ID_LIMIT = 100;

const SORT_OPTIONS = [
  { value: "priority", label: "Priority" },
  { value: "updated_at", label: "Recent" }
] as const;

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
  identity,
  rows,
  detail,
  banner,
  notice,
  view,
  hasNext,
  detailOpen,
  composeAction,
  renderedAt
}: {
  session: HumanAccountSession;
  identity: HumanAccountIdentityDisplay;
  rows: HumanReviewListRow[];
  detail: HumanReviewDetail | null;
  banner: StatusResult<HumanAccountBannerData>;
  notice: HumanReviewNotice | null;
  view: HumanReviewView;
  hasNext: boolean;
  detailOpen: boolean;
  composeAction?: string | null;
  renderedAt: string;
}) {
  const router = useRouter();
  const { mutations, enqueue, dismiss } = useAppActions();
  const [search, setSearch] = useState(view.search);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [hydratedAccountId, setHydratedAccountId] = useState<string | null>(
    null
  );
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSearch = useRef<string | null>(null);
  const previousDetailId = useRef<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const previousCanonicalRows = useRef(rows);
  const canonicalGeneration = useRef(0);
  const successGenerations = useRef(new Map<string, number>());
  const retriedCanonicalRefreshes = useRef(new Set<string>());

  useEffect(() => {
    const persisted = readWorkspaceState(session.accountId);
    setSelectedIds(new Set(persisted?.selectedIds ?? []));
    setSkippedIds(new Set(persisted?.skippedIds ?? []));
    setSelectionMode((persisted?.selectedIds.length ?? 0) > 0);
    setHydratedAccountId(session.accountId);
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
    const selector = "details[data-dismissible-disclosure]";
    const closeDisclosures = (except?: HTMLDetailsElement) => {
      document
        .querySelectorAll<HTMLDetailsElement>(selector)
        .forEach((item) => {
          if (item !== except) item.open = false;
        });
    };
    const handleToggle = (event: Event) => {
      const disclosure = event.target;
      if (disclosure instanceof HTMLDetailsElement && disclosure.open) {
        closeDisclosures(disclosure);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(selector)) {
        closeDisclosures();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openDisclosure = document.querySelector<HTMLDetailsElement>(
        `${selector}[open]`
      );
      closeDisclosures();
      openDisclosure?.querySelector<HTMLElement>("summary")?.focus();
    };

    document.addEventListener("toggle", handleToggle, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("toggle", handleToggle, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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
    if (pendingSearch.current !== null) {
      if (view.search === pendingSearch.current) {
        pendingSearch.current = null;
      } else {
        return;
      }
    }
    setSearch(view.search);
  }, [view.search]);

  const noticeEpoch = [
    notice?.kind ?? "",
    notice?.message ?? "",
    notice?.failedActionKind ?? "",
    notice?.undo?.inputItemId ?? "",
    notice?.undo?.outputResultId ?? "",
    notice?.undo?.callerId ?? ""
  ].join("\0");

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
    params.delete("compose");
    // Seed from the URL, not the `view` prop: the prop lags router.replace
    // until the server round-trip completes, so rapid successive control
    // changes would silently revert earlier ones.
    const next = { ...humanReviewViewFromSearchParams(params), ...changes };
    writeHumanReviewView(params, next);
    const href = `${window.location.pathname}?${params.toString()}`;
    router.replace(href, { scroll: false });
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

  useEffect(() => {
    cancelDebouncedSearch();
  }, [view.status, view.sort, view.page]);
  useEffect(() => {
    const currentId = detail?.inputItemId ?? null;
    if (currentId !== null && currentId !== previousDetailId.current) {
      cancelDebouncedSearch();
    }
    previousDetailId.current = currentId;
  }, [detail?.inputItemId]);

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

  const humanMutations = useMemo(
    () =>
      mutations.flatMap((record) =>
        record.scope === HUMAN_MUTATION_SCOPE &&
        isHumanOptimisticMutation(record.optimistic)
          ? [{ record, mutation: record.optimistic }]
          : []
      ),
    [mutations]
  );
  const hiddenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { mutation } of humanMutations) {
      if (mutation.operation !== "undo") {
        mutation.inputItemIds.forEach((id) => ids.add(id));
      }
    }
    return ids;
  }, [humanMutations]);
  const restoredRows = useMemo(() => {
    const baseIds = new Set(rows.map((row) => row.inputItemId));
    const restored = new Map<string, HumanReviewListRow>();
    for (const { mutation } of humanMutations) {
      if (mutation.operation !== "undo") continue;
      if (view.status !== "pending" && !mutation.requiresCanonicalPendingRow) {
        continue;
      }
      for (const row of mutation.rowSnapshots) {
        if (!baseIds.has(row.inputItemId)) {
          restored.set(row.inputItemId, row);
        }
      }
    }
    return [...restored.values()];
  }, [humanMutations, rows, view.status]);
  const lockedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { record, mutation } of humanMutations) {
      if (mutation.operation === "undo" && record.status !== "succeeded") {
        mutation.inputItemIds.forEach((id) => ids.add(id));
      }
    }
    return ids;
  }, [humanMutations]);

  const projectedRows = useMemo(
    () =>
      [...rows, ...restoredRows].filter(
        (row) => !hiddenIds.has(row.inputItemId)
      ),
    [hiddenIds, restoredRows, rows]
  );
  const synchronizingMutationCount = humanMutations.filter(
    ({ record }) => record.status !== "succeeded"
  ).length;
  const actionStatus =
    synchronizingMutationCount > 0
      ? `${synchronizingMutationCount} review ${synchronizingMutationCount === 1 ? "update" : "updates"} waiting to synchronize.`
      : "";

  useEffect(() => {
    if (previousCanonicalRows.current === rows) return;
    previousCanonicalRows.current = rows;
    canonicalGeneration.current += 1;
  }, [rows]);

  useEffect(() => {
    for (const { record, mutation } of humanMutations) {
      if (record.status !== "succeeded") continue;
      const successGeneration = successGenerations.current.get(record.id);
      if (successGeneration === undefined) {
        continue;
      }
      const minimumGeneration = successGeneration + 1;
      if (canonicalGeneration.current < minimumGeneration) {
        if (
          canonicalGeneration.current > successGeneration &&
          !retriedCanonicalRefreshes.current.has(record.id)
        ) {
          retriedCanonicalRefreshes.current.add(record.id);
          router.refresh();
        }
        continue;
      }
      const canonicalRows = mutation.inputItemIds.map((id) =>
        rows.find((row) => row.inputItemId === id)
      );
      const reflected =
        mutation.operation === "undo"
          ? mutation.requiresCanonicalPendingRow
            ? canonicalRows.every((row, index) => {
                const snapshot = mutation.rowSnapshots.find(
                  (candidate) =>
                    candidate.inputItemId === mutation.inputItemIds[index]
                );
                return (
                  row?.status === "pending" &&
                  snapshot !== undefined &&
                  row.currentRevision >= snapshot.currentRevision
                );
              })
            : canonicalRows.every(
                (row) => row === undefined || row.status === "pending"
              )
          : mutation.operation === "bulk-answer"
            ? canonicalRows.some(
                (row) => row === undefined || row.status !== "pending"
              )
            : canonicalRows.every(
                (row) => row === undefined || row.status !== "pending"
              );
      if (reflected) {
        successGenerations.current.delete(record.id);
        retriedCanonicalRefreshes.current.delete(record.id);
        dismiss(record.id);
      } else if (!retriedCanonicalRefreshes.current.has(record.id)) {
        retriedCanonicalRefreshes.current.add(record.id);
        router.refresh();
      }
    }
  }, [dismiss, humanMutations, router, rows]);

  const visibleRows = useMemo(() => {
    return [...projectedRows].sort((left, right) => {
      const leftSkipped = skippedIds.has(left.inputItemId);
      const rightSkipped = skippedIds.has(right.inputItemId);
      if (leftSkipped !== rightSkipped) {
        return leftSkipped ? 1 : -1;
      }
      return 0;
    });
  }, [projectedRows, skippedIds]);
  const selectedRows = useMemo(
    () => visibleRows.filter((row) => selectedIds.has(row.inputItemId)),
    [selectedIds, visibleRows]
  );
  const offPageSelectedCount = useMemo(() => {
    const visibleIds = new Set(projectedRows.map((row) => row.inputItemId));
    let count = 0;
    for (const id of selectedIds) {
      if (!visibleIds.has(id)) {
        count += 1;
      }
    }
    return count;
  }, [projectedRows, selectedIds]);
  const pendingCount = projectedRows.filter(
    (row) => row.status === "pending"
  ).length;
  const queueCount = queueCountCopy(
    view.status,
    pendingCount,
    projectedRows.length,
    hasNext,
    view.page
  );
  const detailIndex = detail
    ? visibleRows.findIndex((row) => row.inputItemId === detail.inputItemId)
    : -1;
  const previousDetailRow =
    detailIndex > 0 ? visibleRows[detailIndex - 1] : null;
  const nextDetailRow =
    detailIndex >= 0 && detailIndex < visibleRows.length - 1
      ? visibleRows[detailIndex + 1]
      : null;

  const handleHumanMutation: OnHumanMutation = (submission) => {
    const rowSnapshots = projectedRows.filter((row) =>
      submission.inputItemIds.includes(row.inputItemId)
    );
    enqueueHumanMutation(submission, rowSnapshots);
    if (detail && submission.inputItemIds.includes(detail.inputItemId)) {
      router.replace(humanReviewHref(view), { scroll: false });
    }
  };

  function enqueueHumanMutation(
    submission: HumanMutationSubmission,
    rowSnapshots: HumanReviewListRow[],
    requiresCanonicalPendingRow = submission.operation === "undo" &&
      rowSnapshots.some((row) => row.status === "pending")
  ) {
    const optimistic: HumanOptimisticMutation = {
      operation: submission.operation,
      inputItemIds: submission.inputItemIds,
      rowSnapshots: requiresCanonicalPendingRow
        ? rowSnapshots.map((row) => ({
            ...row,
            currentRevision: row.currentRevision + 2
          }))
        : rowSnapshots,
      requiresCanonicalPendingRow
    };
    enqueue({
      scope: HUMAN_MUTATION_SCOPE,
      optimistic,
      execute: () =>
        synchronizeHumanMutation(submission.operation, submission.formData),
      refreshOnSuccess: true,
      onSuccess: (result, mutationId) => {
        if (result.operation === "bulk-answer" && result.answered === 0) {
          successGenerations.current.delete(mutationId);
          retriedCanonicalRefreshes.current.delete(mutationId);
          dismiss(mutationId);
          toast.warning(result.message, {
            id: mutationId,
            duration: Infinity
          });
          return;
        }
        successGenerations.current.set(mutationId, canonicalGeneration.current);
        if (result.operation === "answer") {
          toast.success(result.message, {
            id: mutationId,
            action: {
              label: "Undo",
              onClick: () => {
                dismiss(mutationId);
                const undoForm = new FormData();
                undoForm.set("inputItemId", result.undo.inputItemId);
                undoForm.set("callerId", result.undo.callerId);
                undoForm.set("outputResultId", result.undo.outputResultId);
                enqueueHumanMutation(
                  {
                    operation: "undo",
                    inputItemIds: [result.undo.inputItemId],
                    formData: undoForm
                  },
                  rowSnapshots,
                  viewRef.current.status === "pending"
                );
              }
            }
          });
          return;
        }
        if (result.operation === "bulk-answer" && result.failed > 0) {
          toast.warning(result.message, {
            id: mutationId,
            duration: Infinity
          });
          return;
        }
        toast.success(result.message, { id: mutationId });
      },
      onIndeterminate: (_error, mutationId) => {
        successGenerations.current.set(mutationId, canonicalGeneration.current);
      },
      onError: (error, mutationId) => {
        successGenerations.current.delete(mutationId);
        retriedCanonicalRefreshes.current.delete(mutationId);
        const message =
          error instanceof HumanMutationError
            ? error.message
            : "Action is temporarily unavailable.";
        toast.error(message, {
          id: mutationId,
          duration: Infinity
        });
      }
    });
  }

  useEffect(() => {
    if (!notice) return;
    const options = {
      id: noticeEpoch,
      ...(notice.undo
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                const formData = new FormData();
                formData.set("inputItemId", notice.undo?.inputItemId ?? "");
                formData.set("callerId", notice.undo?.callerId ?? "");
                formData.set(
                  "outputResultId",
                  notice.undo?.outputResultId ?? ""
                );
                handleHumanMutation({
                  operation: "undo",
                  inputItemIds: [notice.undo?.inputItemId ?? ""],
                  formData
                });
              }
            }
          }
        : {}),
      ...(notice.kind === "error" ? { duration: Infinity } : {})
    };
    if (notice.kind === "error") {
      toast.error(notice.message, options);
    } else {
      toast.success(notice.message, options);
    }
  }, [notice, noticeEpoch]);

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

  useEffect(() => {
    function moveQueueFocus(event: KeyboardEvent) {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      ) {
        return;
      }
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest("input, select, textarea, button, summary, dialog")
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      const rows = [
        ...document.querySelectorAll<HTMLElement>(".review-list .row-link")
      ];
      if (key === "enter") {
        const focused = document.activeElement;
        if (
          focused instanceof HTMLAnchorElement &&
          focused.classList.contains("row-link")
        ) {
          const href = focused.getAttribute("href");
          if (href) {
            event.preventDefault();
            router.push(href);
          }
        }
        return;
      }
      if (
        key !== "j" &&
        key !== "k" &&
        key !== "arrowdown" &&
        key !== "arrowup"
      ) {
        return;
      }
      if (rows.length === 0) return;
      const activeIndex = rows.findIndex(
        (row) => row === document.activeElement
      );
      const moveForward = key === "j" || key === "arrowdown";
      const nextIndex =
        activeIndex < 0
          ? moveForward
            ? 0
            : rows.length - 1
          : activeIndex + (moveForward ? 1 : -1);
      if (nextIndex < 0 || nextIndex >= rows.length) return;
      const nextRow = rows[nextIndex];
      if (!nextRow) return;
      event.preventDefault();
      nextRow.focus();
    }

    window.addEventListener("keydown", moveQueueFocus);
    return () => window.removeEventListener("keydown", moveQueueFocus);
  }, [router]);

  return (
    <main
      className="human-workspace"
      data-workspace-hydrated={
        hydratedAccountId === session.accountId ? "true" : "false"
      }
    >
      <header className="app-bar">
        <Link
          className="app-brand product-wordmark"
          href="/human"
          aria-label="Agent Outbox home"
        >
          <img src="/agent-outbox-mark.svg" alt="" width="36" height="36" />
          <span>
            Agent <b>Outbox</b>
          </span>
        </Link>
        <nav className="app-location" aria-label="Primary">
          <Link
            className={view.status === "answered" ? undefined : "active"}
            href={humanReviewHref({
              ...view,
              search,
              status: "pending",
              page: 1
            })}
            aria-current={view.status === "answered" ? undefined : "page"}
          >
            Review queue
          </Link>
          <Link
            className={view.status === "answered" ? "active" : undefined}
            href={humanReviewHref({
              ...view,
              search,
              status: "answered",
              page: 1
            })}
            aria-current={view.status === "answered" ? "page" : undefined}
          >
            History
          </Link>
        </nav>
        <div className="app-account">
          <AccountBanner banner={banner} identity={identity} />
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

      <div
        id="human-optimistic-status"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {actionStatus}
      </div>

      <div className="workspace-body queue-only">
        <section
          className={`queue-pane${view.page > 1 || hasNext ? " paginated" : ""}`}
          aria-label="Queue browser"
        >
          <header className="queue-header">
            <div className="queue-heading">
              <span className="queue-eyebrow">Human review</span>
              <h2>
                {view.status === "pending"
                  ? "Needs review"
                  : "Answered reviews"}
              </h2>
              <div className="queue-count" aria-label="Current view summary">
                <strong>{queueCount.value}</strong>
                <span>{queueCount.label}</span>
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
              <span className="mobile-tools-copy">
                {mobileToolsOpen ? "Close filters" : "Search & filter"}
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
                      pendingSearch.current = event.target.value;
                      setSearch(event.target.value);
                      applyDebouncedSearch(event.target.value);
                    }}
                    placeholder="Search title, customer, or summary"
                  />
                </label>
              </form>
              <div className="filter-controls">
                <SlidersHorizontal aria-hidden="true" />
                <ViewSelect
                  label="Sort"
                  value={view.sort}
                  options={SORT_OPTIONS}
                  onChange={(sort) =>
                    updateViewImmediately({
                      sort: sort as HumanReviewView["sort"],
                      page: 1
                    })
                  }
                />
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
            onMutation={handleHumanMutation}
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
              onMutation={handleHumanMutation}
              lockedIds={lockedIds}
            />
            {!hasNext && visibleRows.length > 0 ? (
              <div className="queue-end">
                <span>End of queue</span>
                <span className="queue-keyboard-hint">
                  <kbd>J</kbd>
                  <kbd>K</kbd> move · <kbd>Enter</kbd> open
                </span>
                {view.status === "pending" ? (
                  <Link
                    href={humanReviewHref({
                      ...view,
                      search: "",
                      status: "answered",
                      page: 1
                    })}
                  >
                    Review answered decisions
                  </Link>
                ) : (
                  <Link
                    href={humanReviewHref({
                      ...view,
                      search: "",
                      status: "pending",
                      page: 1
                    })}
                  >
                    Return to review queue
                  </Link>
                )}
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
      </div>

      {detailOpen &&
      detail &&
      !hiddenIds.has(detail.inputItemId) &&
      !lockedIds.has(detail.inputItemId) ? (
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
          composeAction={composeAction}
          onMutation={handleHumanMutation}
        />
      ) : null}
    </main>
  );
}

function ViewSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selected = options.find((option) => option.value === value);

  return (
    <details
      className="view-select"
      ref={detailsRef}
      data-dismissible-disclosure
    >
      <summary
        role="button"
        aria-label={`${label}: ${selected?.label ?? value}`}
      >
        <span>{label}</span>
        <strong>{selected?.label ?? value}</strong>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="view-select-menu" role="menu" aria-label={label}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => {
                detailsRef.current?.removeAttribute("open");
                onChange(option.value);
              }}
            >
              <span>{option.label}</span>
              {active ? <Check aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </details>
  );
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

function queueCountCopy(
  status: HumanReviewView["status"],
  pendingCount: number,
  rowCount: number,
  hasNext: boolean,
  page: number
): { value: string; label: string } {
  const pageScoped = page > 1 || hasNext;
  if (status === "answered") {
    return {
      value: `${rowCount}`,
      label: pageScoped ? "shown" : "answered"
    };
  }
  return {
    value: `${pendingCount}`,
    label: pageScoped ? "shown" : "remaining"
  };
}
