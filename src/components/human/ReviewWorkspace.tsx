"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  ListChecks,
  MoreHorizontal,
  Search,
  X
} from "lucide-react";

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
  humanReviewMatchesFacets,
  humanReviewMatchesSearch,
  humanReviewViewFromSearchParams,
  writeHumanReviewView,
  type HumanReviewView
} from "../../shared/human-review-view";
import { compareHumanReviewRows } from "../../shared/human-review-sort";
import { htmlToPlainText } from "../../shared/html-text";
import { AccountBanner } from "./AccountBanner";
import { ThemeToggle } from "./ThemeToggle";
import {
  LastAnswerUndoForm,
  type HumanMutationSubmission,
  type OnHumanMutation
} from "./ActionForms";
import { BulkActions } from "./BulkActions";
import { ReviewDetail, ReviewDetailLoading } from "./ReviewDetail";
import { ReviewList } from "./ReviewList";
import {
  ActiveFilterChips,
  ReviewViewControls,
  sortDirectionLabel,
  sortLabel
} from "./ReviewViewControls";
import { useReviewSelection } from "./review-selection";
import { useFeedbackDrafts } from "./Feedback";
import {
  HUMAN_MUTATION_SCOPE,
  HumanMutationError,
  isHumanOptimisticMutation,
  isHumanMutationResult,
  synchronizeHumanMutation,
  type HumanOptimisticMutation
} from "./human-mutation-client";

// Query parameters the server action redirect writes to report a mutation.
const REDIRECT_NOTICE_PARAMS = [
  "notice",
  "error",
  "failedActionKind",
  "action",
  "answered",
  "failed",
  "undo_target",
  "undo_actor",
  "undo_result",
  "resolved",
  "subject"
] as const;

const STATUS_LINKS = [
  { status: "pending", label: "Review queue" },
  { status: "answered", label: "History" }
] as const;

export type HumanReviewNotice = {
  kind: "notice" | "error";
  message: string;
  failedActionKind?: "file_upload";
  actionLabel?: string;
  undo?: {
    inputItemId: string;
    callerId: string;
    outputResultId: string;
  };
};

type LastAnswerUndo = {
  inputItemId: string;
  callerId: string;
  outputResultId: string;
  actionLabel: string | null;
  rowSnapshots: HumanReviewListRow[];
};

export function ReviewWorkspace({
  session,
  identity,
  rows,
  typeOptions,
  detail,
  banner,
  notice,
  view,
  hasNext,
  totalCount,
  detailOpen,
  composeAction,
  renderedAt
}: {
  session: HumanAccountSession;
  identity: HumanAccountIdentityDisplay;
  rows: HumanReviewListRow[];
  typeOptions: string[];
  detail: HumanReviewDetail | null;
  banner: StatusResult<HumanAccountBannerData>;
  notice: HumanReviewNotice | null;
  view: HumanReviewView;
  hasNext: boolean;
  totalCount: number;
  detailOpen: boolean;
  composeAction?: string | null;
  renderedAt: string;
}) {
  const router = useRouter();
  const feedback = useFeedbackDrafts(session.accountId, session.userId);
  const { mutations, currentMutations, enqueue, dismiss } = useAppActions();
  const {
    selectedIds,
    skippedIds,
    selectionMode,
    hydrated,
    setRowSelected,
    toggleSkipped,
    toggleSelectionMode,
    deselect
  } = useReviewSelection(session.accountId, rows);
  const [search, setSearch] = useState(view.search);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [lastUndo, setLastUndo] = useState<LastAnswerUndo | null>(() =>
    lastAnswerUndoFromNotice(notice)
  );
  const [lastError, setLastError] = useState<string | null>(() =>
    notice?.kind === "error" ? notice.message : null
  );
  const [pendingDetail, setPendingDetail] = useState<{
    inputItemId: string;
    label: string;
  } | null>(null);
  const [detailDismissed, setDetailDismissed] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const [controlView, setControlView] = useState(view);
  const controlViewRef = useRef(view);
  const requestedViewHref = useRef<string | null>(null);
  const incomingViewRef = useRef(view);
  incomingViewRef.current = view;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSearch = useRef<string | null>(null);
  const previousDetailId = useRef<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const previousCanonicalRows = useRef(rows);
  const canonicalGeneration = useRef(0);
  const successGenerations = useRef(new Map<string, number>());
  const retriedCanonicalRefreshes = useRef(new Set<string>());
  const consumedNoticeEpoch = useRef<string | null>(null);
  const viewConfigurationKey = [
    view.status,
    view.priorities.join(","),
    view.types.join(","),
    view.sorts.map(({ key, direction }) => `${key}:${direction}`).join(","),
    view.page
  ].join("\0");
  const canonicalViewHref = humanReviewHref(view);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("caller_id") && !params.has("caller_item_id")) return;
    // Forms read their return view from the URL. Keep the resolved status/page
    // there too, while preserving the shareable caller-owned card identity.
    writeHumanReviewView(params, viewRef.current);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params}`
    );
  }, [canonicalViewHref]);

  useEffect(() => {
    if (
      requestedViewHref.current !== null &&
      requestedViewHref.current !== canonicalViewHref
    ) {
      return;
    }
    requestedViewHref.current = null;
    const incomingView = incomingViewRef.current;
    controlViewRef.current = incomingView;
    setControlView(incomingView);
  }, [canonicalViewHref]);

  useEffect(() => {
    const clearRequestedView = () => {
      requestedViewHref.current = null;
      setDetailDismissed(false);
    };
    window.addEventListener("popstate", clearRequestedView);
    return () => window.removeEventListener("popstate", clearRequestedView);
  }, []);

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

  function updateView(
    changes: Partial<HumanReviewView>,
    navigation: "replace" | "push" = "replace"
  ) {
    const params = new URLSearchParams(window.location.search);
    for (const key of [
      "item",
      "caller_id",
      "caller_item_id",
      "compose",
      ...REDIRECT_NOTICE_PARAMS
    ]) {
      params.delete(key);
    }
    // Compose from the latest optimistic view. Both the rendered prop and the
    // browser URL can lag router.replace during rapid, sequential changes.
    const draft = { ...controlViewRef.current, ...changes };
    const canonicalParams = new URLSearchParams();
    writeHumanReviewView(canonicalParams, draft);
    const next = humanReviewViewFromSearchParams(canonicalParams);
    controlViewRef.current = next;
    setControlView(next);
    requestedViewHref.current = humanReviewHref(next);
    writeHumanReviewView(params, next);
    const href = `${window.location.pathname}?${params.toString()}`;
    router[navigation](href, { scroll: false });
  }

  function clearRedirectNoticeFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (!REDIRECT_NOTICE_PARAMS.some((key) => params.has(key))) {
      return;
    }
    for (const key of REDIRECT_NOTICE_PARAMS) params.delete(key);
    const query = params.toString();
    router.replace(
      query ? `${window.location.pathname}?${query}` : window.location.pathname,
      { scroll: false }
    );
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
      const normalizedSearch = nextSearch.trim();
      pendingSearch.current = normalizedSearch;
      setSearch(normalizedSearch);
      updateView({ search: normalizedSearch, page: 1 });
    }, 300);
  }

  useEffect(() => {
    cancelDebouncedSearch();
  }, [viewConfigurationKey]);
  useEffect(() => {
    const currentId = detail?.inputItemId ?? null;
    if (currentId !== null && currentId !== previousDetailId.current) {
      cancelDebouncedSearch();
    }
    previousDetailId.current = currentId;
  }, [detail?.inputItemId]);

  useEffect(() => {
    if (
      pendingDetail &&
      detailOpen &&
      detail?.inputItemId === pendingDetail.inputItemId
    ) {
      setPendingDetail(null);
    }
  }, [detail?.inputItemId, detailOpen, pendingDetail]);

  useEffect(() => {
    if (!detailDismissed || !detailOpen) return;
    router.replace(humanReviewHref(controlViewRef.current), { scroll: false });
  }, [detailDismissed, detailOpen, router]);

  function currentSearch() {
    return pendingSearch.current ?? search;
  }

  function submitSearch() {
    cancelDebouncedSearch();
    const normalizedSearch = currentSearch().trim();
    pendingSearch.current = normalizedSearch;
    setSearch(normalizedSearch);
    updateView({ search: normalizedSearch, page: 1 });
  }

  function updateViewImmediately(
    changes: Partial<HumanReviewView>,
    navigation: "replace" | "push" = "replace"
  ) {
    cancelDebouncedSearch();
    const nextSearch = currentSearch().trim();
    if (nextSearch !== search) {
      pendingSearch.current = nextSearch;
      setSearch(nextSearch);
    }
    updateView(
      nextSearch === view.search
        ? changes
        : { ...changes, search: nextSearch, page: 1 },
      navigation
    );
  }

  function onStatusNavigate(
    status: HumanReviewView["status"],
    changes: Partial<HumanReviewView> = {}
  ) {
    return (event: { preventDefault: () => void }) => {
      event.preventDefault();
      updateViewImmediately({ ...changes, status, page: 1 }, "push");
    };
  }

  const humanMutations = useMemo(
    () =>
      mutations.flatMap((record) => {
        const optimistic = record.optimistic;
        if (
          record.scope !== HUMAN_MUTATION_SCOPE ||
          !isHumanOptimisticMutation(optimistic)
        )
          return [];
        const result = record.result;
        const mutation =
          isHumanMutationResult(result) &&
          result.ok &&
          result.operation === "bulk-answer"
            ? {
                ...optimistic,
                inputItemIds: result.answeredInputItemIds.filter((id) =>
                  optimistic.inputItemIds.includes(id)
                )
              }
            : optimistic;
        return [{ record, mutation }];
      }),
    [mutations]
  );
  // Project the latest intent per item. Older entries stay available for rollback
  // until a confirmed result supersedes precisely the affected items.
  const itemMutations = useMemo(() => {
    const latest = new Map<string, (typeof humanMutations)[number]>();
    for (const entry of humanMutations) {
      for (const id of entry.mutation.inputItemIds) latest.set(id, entry);
    }
    return latest;
  }, [humanMutations]);
  const hiddenIds = useMemo(
    () =>
      new Set(
        [...itemMutations]
          .filter(([, { mutation }]) => mutation.operation !== "undo")
          .map(([id]) => id)
      ),
    [itemMutations]
  );
  const lockedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, { record, mutation }] of itemMutations) {
      if (mutation.operation === "undo" && record.status !== "succeeded") {
        ids.add(id);
      }
    }
    return ids;
  }, [itemMutations]);

  const projectedRows = useMemo(() => {
    const projected = new Map(rows.map((row) => [row.inputItemId, row]));
    let restored = false;
    for (const [id, { mutation }] of itemMutations) {
      if (mutation.operation !== "undo") {
        projected.delete(id);
        continue;
      }
      if (view.status !== "pending") continue;
      const snapshot = mutation.rowSnapshots.find(
        (row) => row.inputItemId === id
      );
      if (!snapshot || !humanReviewRowMatchesView(snapshot, view)) continue;
      const canonical = projected.get(id);
      if (!canonical || canonical.currentRevision < snapshot.currentRevision) {
        projected.set(id, snapshot);
        restored = true;
      }
    }
    const projectedRows = [...projected.values()];
    return restored
      ? projectedRows.sort((left, right) =>
          compareHumanReviewRows(left, right, view)
        )
      : projectedRows;
  }, [itemMutations, rows, view]);
  const synchronizingMutationCount = humanMutations.filter(
    ({ record }) => record.status !== "succeeded"
  ).length;
  const actionStatus =
    synchronizingMutationCount > 0
      ? `${synchronizingMutationCount} review ${synchronizingMutationCount === 1 ? "update" : "updates"} waiting to synchronize.`
      : "";
  const viewStatus = humanReviewViewAnnouncement(view);
  const otherStatus = view.status === "pending" ? "answered" : "pending";

  function forgetMutation(mutationId: string) {
    successGenerations.current.delete(mutationId);
    retriedCanonicalRefreshes.current.delete(mutationId);
  }

  function retireMutation(mutationId: string) {
    forgetMutation(mutationId);
    dismiss(mutationId);
  }

  useEffect(() => {
    if (previousCanonicalRows.current === rows) return;
    previousCanonicalRows.current = rows;
    canonicalGeneration.current += 1;
  }, [rows]);

  useEffect(() => {
    for (const { record, mutation } of humanMutations) {
      if (record.status !== "succeeded" && record.status !== "indeterminate")
        continue;
      const successGeneration = successGenerations.current.get(record.id);
      if (successGeneration === undefined) {
        continue;
      }
      const minimumGeneration = successGeneration + 1;
      if (canonicalGeneration.current < minimumGeneration) {
        continue;
      }
      const canonicalRows = mutation.inputItemIds.map((id) =>
        rows.find((row) => row.inputItemId === id)
      );
      // After a timeout, a fresh bulk view must also release the projection
      // when every submitted row is still pending, so those rows can be retried.
      // Selection removal below independently requires evidence of an answer.
      const reflected =
        (mutation.operation === "bulk-answer" &&
          record.status === "indeterminate") ||
        (mutation.operation === "undo"
          ? mutation.requiresCanonicalPendingRow
            ? canonicalRows.every((row, index) => {
                const snapshot = mutation.rowSnapshots.find(
                  (candidate) =>
                    candidate.inputItemId === mutation.inputItemIds[index]
                );
                return (
                  snapshot !== undefined &&
                  (!humanReviewRowMatchesView(snapshot, view) ||
                    (row?.status === "pending" &&
                      row.currentRevision >= snapshot.currentRevision))
                );
              })
            : canonicalRows.every(
                (row) => row === undefined || row.status === "pending"
              )
          : canonicalRows.every(
              (row) => row === undefined || row.status !== "pending"
            ));
      if (reflected) {
        // A later answer can reach the server before the undo's pending row
        // ever reaches this view. Retire that older restoration along with
        // the answer, or it will resurrect the answered (possibly acked) item.
        if (
          mutation.operation === "answer" &&
          record.status === "indeterminate"
        ) {
          for (const earlier of humanMutations) {
            if (earlier.record.id === record.id) break;
            if (
              earlier.mutation.operation === "undo" &&
              earlier.mutation.inputItemIds.every((id) =>
                mutation.inputItemIds.includes(id)
              )
            ) {
              retireMutation(earlier.record.id);
            }
          }
        }
        if (
          mutation.operation !== "undo" &&
          record.status === "indeterminate"
        ) {
          const answeredIds = new Set(
            mutation.inputItemIds.filter((id, index) => {
              const row = canonicalRows[index];
              if (row) return row.status !== "pending";
              // Absence proves an answer only when this is the entire
              // pending view and the submitted row belongs in that view.
              // A filter or page can otherwise hide a still-pending item.
              const snapshot = mutation.rowSnapshots.find(
                (candidate) => candidate.inputItemId === id
              );
              return (
                view.page === 1 &&
                !hasNext &&
                rows.length === totalCount &&
                snapshot !== undefined &&
                humanReviewRowMatchesView(snapshot, view)
              );
            })
          );
          deselect(answeredIds);
        }
        retireMutation(record.id);
      } else if (!retriedCanonicalRefreshes.current.has(record.id)) {
        retriedCanonicalRefreshes.current.add(record.id);
        router.refresh();
      }
    }
  }, [
    deselect,
    dismiss,
    hasNext,
    humanMutations,
    router,
    rows,
    totalCount,
    view
  ]);

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
  // Apply only the local projection's delta; refreshed server totals already
  // account for answers that have left the canonical page.
  const projectedTotalCount = Math.max(
    0,
    totalCount + projectedRows.length - rows.length
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

  useEffect(() => {
    if (!detailOpen || !detail || detailDismissed) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`review-row-${detail.inputItemId}`)
        ?.scrollIntoView({
          block: "center",
          behavior: "instant"
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [detailOpen, detail?.inputItemId, detailDismissed, visibleRows]);

  const handleHumanMutation: OnHumanMutation = (submission) => {
    const rowSnapshots = projectedRows.filter((row) =>
      submission.inputItemIds.includes(row.inputItemId)
    );
    enqueueHumanMutation(submission, rowSnapshots);
    if (detail && submission.inputItemIds.includes(detail.inputItemId)) {
      setDetailDismissed(true);
      setPendingDetail(null);
      router.replace(humanReviewHref(view), { scroll: false });
    }
  };

  function closeDetail() {
    setDetailDismissed(true);
    setPendingDetail(null);
    router.push(humanReviewHref(controlViewRef.current), { scroll: false });
    if (detail) {
      requestAnimationFrame(() => {
        const row = document.getElementById(`review-row-${detail.inputItemId}`);
        row?.scrollIntoView({ block: "center", behavior: "instant" });
        row
          ?.querySelector<HTMLElement>(".row-details-link")
          ?.focus({ preventScroll: true });
      });
    }
  }

  function enqueueHumanMutation(
    submission: HumanMutationSubmission,
    rowSnapshots: HumanReviewListRow[],
    requiresCanonicalPendingRow = submission.operation === "undo" &&
      rowSnapshots.some((row) => row.status === "pending")
  ) {
    // Repeated activation before the optimistic projection renders would send
    // the same items again; once settled, they are submittable again.
    const unsettledIds = new Set(
      currentMutations().flatMap((record) =>
        record.scope === HUMAN_MUTATION_SCOPE &&
        (record.status === "queued" || record.status === "syncing") &&
        isHumanOptimisticMutation(record.optimistic)
          ? record.optimistic.inputItemIds
          : []
      )
    );
    if (submission.inputItemIds.every((id) => unsettledIds.has(id))) {
      return;
    }
    if (
      submission.operation === "answer" ||
      submission.operation === "bulk-answer"
    ) {
      for (const id of submission.inputItemIds) {
        submission.formData.set(
          submission.operation === "answer" ? "feedback" : `feedback.${id}`,
          feedback.drafts[id] ?? ""
        );
      }
    }
    if (notice) {
      consumedNoticeEpoch.current = noticeEpoch;
    }
    clearRedirectNoticeFromUrl();
    const optimistic: HumanOptimisticMutation = {
      operation: submission.operation,
      inputItemIds: submission.inputItemIds,
      rowSnapshots: requiresCanonicalPendingRow
        ? rowSnapshots.map((row) => ({
            ...row,
            // Answer preserves the revision; undo increments it once.
            currentRevision: row.currentRevision + 1
          }))
        : rowSnapshots,
      requiresCanonicalPendingRow
    };
    if (
      submission.operation === "answer" ||
      submission.operation === "bulk-answer"
    ) {
      setLastError(null);
    }
    function clearLastUndoFor(inputItemIds: string[]) {
      const outputResultId = normalizedFormText(
        submission.formData,
        "outputResultId"
      );
      setLastUndo((current) => {
        if (!current) {
          return null;
        }
        const matchesAnswer =
          inputItemIds.includes(current.inputItemId) &&
          (!outputResultId || current.outputResultId === outputResultId);
        return matchesAnswer ? null : current;
      });
    }
    enqueue({
      scope: HUMAN_MUTATION_SCOPE,
      optimistic,
      execute: () =>
        synchronizeHumanMutation(submission.operation, submission.formData),
      refreshOnSuccess: true,
      reconcileEarlier: (earlier, result) => {
        if (!isHumanOptimisticMutation(earlier.optimistic))
          return earlier.optimistic;
        const completedIds =
          result.operation === "bulk-answer"
            ? result.answeredInputItemIds
            : result.inputItemIds;
        const remainingIds = earlier.optimistic.inputItemIds.filter(
          (id) => !completedIds.includes(id)
        );
        if (remainingIds.length === earlier.optimistic.inputItemIds.length)
          return earlier.optimistic;
        if (remainingIds.length === 0) {
          forgetMutation(earlier.id);
          return null;
        }
        return {
          ...earlier.optimistic,
          inputItemIds: remainingIds,
          rowSnapshots: earlier.optimistic.rowSnapshots.filter((row) =>
            remainingIds.includes(row.inputItemId)
          )
        };
      },
      onSuccess: (result, mutationId) => {
        const answeredIds =
          result.operation === "answer"
            ? result.inputItemIds
            : result.operation === "bulk-answer"
              ? result.answeredInputItemIds
              : [];
        for (const id of answeredIds) {
          const sent = submission.formData.get(
            result.operation === "answer" ? "feedback" : `feedback.${id}`
          );
          if (typeof sent === "string") feedback.clearSubmitted(id, sent);
        }
        if (answeredIds.length > 0) {
          deselect(new Set(answeredIds));
        }
        if (result.operation === "bulk-answer" && result.answered === 0) {
          retireMutation(mutationId);
          setLastUndo(null);
          setLastError(result.message);
          return;
        }
        successGenerations.current.set(mutationId, canonicalGeneration.current);
        if (result.operation === "answer") {
          setLastUndo({
            inputItemId: result.undo.inputItemId,
            callerId: result.undo.callerId,
            outputResultId: result.undo.outputResultId,
            actionLabel: normalizedFormText(
              submission.formData,
              "noticeAction"
            ),
            rowSnapshots
          });
          setLastError(null);
          return;
        }
        if (result.operation === "undo") {
          clearLastUndoFor(result.inputItemIds);
          setLastError(null);
          return;
        }
        if (result.operation === "bulk-answer") {
          setLastUndo(null);
          if (result.failed > 0) {
            setLastError(result.message);
          }
        }
      },
      onIndeterminate: (_error, mutationId) => {
        successGenerations.current.set(mutationId, canonicalGeneration.current);
      },
      onError: (error, mutationId) => {
        forgetMutation(mutationId);
        if (
          error instanceof HumanMutationError &&
          (error.result?.code === "not_found" ||
            error.result?.code === "input_not_pending" ||
            error.result?.code === "stale_input_revision")
        ) {
          // The server has invalidated this snapshot. Drop older undo copies
          // and fetch the current row before another answer is attempted.
          for (const { record, mutation } of humanMutations) {
            if (
              mutation.operation === "undo" &&
              mutation.inputItemIds.some((id) =>
                submission.inputItemIds.includes(id)
              )
            ) {
              retireMutation(record.id);
            }
          }
          router.refresh();
        }
        if (
          submission.operation === "undo" &&
          error instanceof HumanMutationError &&
          (error.result?.code === "output_already_read" ||
            error.result?.code === "not_found")
        ) {
          // These undo rejections are permanent; retrying cannot succeed.
          clearLastUndoFor(submission.inputItemIds);
        }
        const message =
          error instanceof HumanMutationError
            ? error.message
            : "Action is temporarily unavailable.";
        setLastError(mutationFailureMessage(submission, rowSnapshots, message));
      }
    });
  }

  useEffect(() => {
    if (!notice) return;
    if (consumedNoticeEpoch.current === noticeEpoch) return;
    consumedNoticeEpoch.current = noticeEpoch;
    const undo = lastAnswerUndoFromNotice(notice);
    if (undo) {
      setLastUndo((current) => current ?? undo);
      setLastError(null);
    } else if (notice.kind === "error") {
      setLastError(notice.message);
    }
    clearRedirectNoticeFromUrl();
  }, [notice, noticeEpoch]);

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
  }, []);

  const statusLinks = STATUS_LINKS.map(({ status, label }) => (
    <Link
      key={status}
      className={view.status === status ? "active" : undefined}
      href={humanReviewHref({ ...controlView, search, status, page: 1 })}
      onNavigate={onStatusNavigate(status)}
      onClick={(event) => {
        const disclosure = event.currentTarget.closest("details");
        if (!disclosure) return;
        disclosure.open = false;
        disclosure.querySelector<HTMLElement>("summary")?.focus();
      }}
      aria-current={view.status === status ? "page" : undefined}
    >
      {label}
    </Link>
  ));

  return (
    <main
      ref={workspaceRef}
      className="human-workspace ph-no-capture"
      data-review-mutation-count={humanMutations.length}
      data-workspace-hydrated={hydrated ? "true" : "false"}
    >
      <header className="app-bar">
        <Link
          className="app-brand product-wordmark"
          href="/human"
          aria-label="Agent Outbox home"
          onNavigate={() => {
            requestedViewHref.current = null;
          }}
        >
          <img src="/agent-outbox-mark.svg" alt="" width="36" height="36" />
          <span>
            Agent <b>Outbox</b>
          </span>
        </Link>
        <nav className="app-location" aria-label="Primary">
          {statusLinks}
        </nav>
        <div className="app-account">
          <div className="app-feedback">
            {lastError ? (
              <p className="last-action-error" role="alert" title={lastError}>
                <span>{lastError}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  onClick={() => setLastError(null)}
                >
                  <X aria-hidden="true" />
                </button>
              </p>
            ) : null}
            {lastUndo ? (
              <LastAnswerUndoForm
                undo={lastUndo}
                disabled={lockedIds.has(lastUndo.inputItemId)}
                onMutation={(submission) => {
                  enqueueHumanMutation(
                    submission,
                    lastUndo.rowSnapshots,
                    viewRef.current.status === "pending"
                  );
                }}
              />
            ) : null}
          </div>
          <ThemeToggle />
          <AccountBanner banner={banner} identity={identity} />
          <details className="navigation-overflow" data-dismissible-disclosure>
            <summary aria-label="Navigation menu">
              <MoreHorizontal aria-hidden="true" size={20} />
            </summary>
            <nav className="navigation-popover" aria-label="Primary">
              {statusLinks}
            </nav>
          </details>
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
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {viewStatus}
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
                <strong>{projectedRows.length}</strong>
                <span>shown of {projectedTotalCount} matching reviews</span>
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
                    placeholder="Search title, subtitle, summary, caller, type, or item ID"
                  />
                </label>
              </form>
              <ReviewViewControls
                view={controlView}
                typeOptions={typeOptions}
                workspaceRef={workspaceRef}
                onChange={(changes) =>
                  updateViewImmediately({ ...changes, page: 1 })
                }
              />
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
              <ActiveFilterChips
                view={controlView}
                onChange={(changes) =>
                  updateViewImmediately({ ...changes, page: 1 })
                }
              />
            </section>
          </header>

          <BulkActions
            selectedRows={selectedRows}
            offPageSelectedCount={offPageSelectedCount}
            onMutation={handleHumanMutation}
          />

          <div className="queue-scroll">
            {feedback.error ? <p role="alert">{feedback.error}</p> : null}
            <ReviewList
              feedbackDrafts={feedback.drafts}
              onFeedbackChange={feedback.change}
              feedbackError={feedback.error}
              rows={visibleRows}
              selectedId={detail?.inputItemId ?? null}
              selectedIds={selectedIds}
              skippedIds={skippedIds}
              onSelectedChange={setRowSelected}
              onSkipToggle={toggleSkipped}
              selectionMode={selectionMode}
              view={controlView}
              renderedAt={renderedAt}
              onMutation={handleHumanMutation}
              lockedIds={lockedIds}
              onDetailNavigate={(inputItemId, label) => {
                setDetailDismissed(false);
                setPendingDetail({ inputItemId, label });
              }}
            />
            {!hasNext && visibleRows.length > 0 ? (
              <div className="queue-end">
                <span>End of queue</span>
                <span className="queue-keyboard-hint">
                  <kbd>J</kbd>
                  <kbd>K</kbd> move · <kbd>Enter</kbd> open
                </span>
                <Link
                  href={humanReviewHref({
                    ...controlView,
                    search: "",
                    status: otherStatus,
                    page: 1
                  })}
                  onNavigate={onStatusNavigate(otherStatus, { search: "" })}
                >
                  {view.status === "pending"
                    ? "Review answered decisions"
                    : "Return to review queue"}
                </Link>
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

      {!detailDismissed &&
      pendingDetail &&
      (!detailOpen || detail?.inputItemId !== pendingDetail.inputItemId) ? (
        <ReviewDetailLoading
          label={pendingDetail.label}
          onCancel={closeDetail}
        />
      ) : null}

      {!detailDismissed &&
      detailOpen &&
      (!pendingDetail || detail?.inputItemId === pendingDetail.inputItemId) &&
      (!detail ||
        (!hiddenIds.has(detail.inputItemId) &&
          !lockedIds.has(detail.inputItemId))) ? (
        <ReviewDetail
          feedback={detail ? (feedback.drafts[detail.inputItemId] ?? "") : ""}
          onFeedbackChange={(text) =>
            detail ? feedback.change(detail.inputItemId, text) : false
          }
          feedbackError={feedback.error}
          key={detail?.inputItemId ?? "empty"}
          detail={detail}
          renderedAt={renderedAt}
          positionLabel={
            detailIndex >= 0
              ? `${detailIndex + 1} of ${visibleRows.length}`
              : null
          }
          previousItem={
            previousDetailRow
              ? {
                  href: humanReviewHref(
                    controlView,
                    previousDetailRow.inputItemId
                  ),
                  label: htmlToPlainText(previousDetailRow.titleHtml)
                }
              : null
          }
          nextItem={
            nextDetailRow
              ? {
                  href: humanReviewHref(controlView, nextDetailRow.inputItemId),
                  label: htmlToPlainText(nextDetailRow.titleHtml)
                }
              : null
          }
          composeAction={composeAction}
          onClose={closeDetail}
          onMutation={handleHumanMutation}
        />
      ) : null}
    </main>
  );
}

function humanReviewViewAnnouncement(view: HumanReviewView) {
  const sort = view.sorts
    .map(
      ({ key, direction }) =>
        `${sortLabel(key)}, ${sortDirectionLabel(key, direction)}`
    )
    .join(", then ");
  const filters = [
    ...view.priorities.map((priority) => `priority ${priority}`),
    ...view.types.map((type) => `type ${type}`)
  ];
  return `View updated. Sorted by ${sort}.${filters.length ? ` Filtered by ${filters.join(", ")}.` : ""}`;
}

function humanReviewRowMatchesView(
  row: HumanReviewListRow,
  view: HumanReviewView
) {
  return (
    view.status === "pending" &&
    humanReviewMatchesFacets(row, view) &&
    humanReviewMatchesSearch(row, view.search.trim())
  );
}

function lastAnswerUndoFromNotice(
  notice: HumanReviewNotice | null
): LastAnswerUndo | null {
  if (!notice?.undo) return null;
  return {
    inputItemId: notice.undo.inputItemId,
    callerId: notice.undo.callerId,
    outputResultId: notice.undo.outputResultId,
    actionLabel: notice.actionLabel ?? null,
    rowSnapshots: []
  };
}

function mutationFailureMessage(
  submission: HumanMutationSubmission,
  rowSnapshots: HumanReviewListRow[],
  message: string
) {
  if (submission.operation === "bulk-answer") {
    return message;
  }
  const subject =
    normalizedFormText(submission.formData, "noticeSubject") ??
    (rowSnapshots.length === 1
      ? htmlToPlainText(rowSnapshots[0]?.titleHtml ?? "")
      : null);
  const quotedSubject = subject ? `“${subject}”` : "this review";
  if (submission.operation === "undo") {
    return `Could not restore ${quotedSubject}: ${message}`;
  }
  return `Could not save ${quotedSubject}: ${message}`;
}

function normalizedFormText(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 160) : null;
}
