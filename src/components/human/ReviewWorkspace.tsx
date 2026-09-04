"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import {
  restrictToParentElement,
  restrictToVerticalAxis
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  GripVertical,
  ListChecks,
  Plus,
  RotateCcw,
  Search,
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
  defaultHumanReviewSortDirection,
  humanReviewHref,
  humanReviewMatchesFacets,
  humanReviewViewFromSearchParams,
  isDefaultHumanReviewOrdering,
  writeHumanReviewView,
  type HumanReviewSort,
  type HumanReviewSortDirection,
  type HumanReviewSortRule,
  type HumanReviewView
} from "../../shared/human-review-view";
import {
  compareHumanReviewRows,
  compareHumanReviewTypeNames
} from "../../shared/human-review-sort";
import { AccountBanner } from "./AccountBanner";
import {
  type HumanMutationSubmission,
  type OnHumanMutation
} from "./ActionForms";
import { BulkActions } from "./BulkActions";
import { ReviewDetail, ReviewDetailLoading } from "./ReviewDetail";
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
  { value: "type", label: "Type" },
  { value: "visual_score", label: "Visual score" },
  { value: "title", label: "Title" },
  { value: "caller", label: "Caller" },
  { value: "created_at", label: "Created" },
  { value: "updated_at", label: "Last updated" }
] as const;

const PRIORITY_FILTER_OPTIONS = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" }
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
  typeOptions,
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
  typeOptions: string[];
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
  const [pendingDetail, setPendingDetail] = useState<{
    inputItemId: string;
    label: string;
  } | null>(null);
  const [detailDismissed, setDetailDismissed] = useState(false);
  const [openViewControl, setOpenViewControl] = useState<
    "filter" | "sort" | null
  >(null);
  const [useViewControlSheet, setUseViewControlSheet] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const [controlView, setControlView] = useState(view);
  const controlViewRef = useRef(view);
  const requestedViewHref = useRef<string | null>(null);
  const incomingViewRef = useRef(view);
  incomingViewRef.current = view;
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
  const indeterminateSuccessMessages = useRef(new Map<string, string>());
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
    const persisted = readWorkspaceState(session.accountId);
    setSelectedIds(new Set(persisted?.selectedIds ?? []));
    setSkippedIds(new Set(persisted?.skippedIds ?? []));
    setSelectionMode((persisted?.selectedIds.length ?? 0) > 0);
    setHydratedAccountId(session.accountId);
  }, [session.accountId]);

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
    const query = window.matchMedia("(max-width: 800px)");
    const synchronize = () => setUseViewControlSheet(query.matches);
    synchronize();
    query.addEventListener("change", synchronize);
    return () => query.removeEventListener("change", synchronize);
  }, []);

  useEffect(() => {
    if (openViewControl === null) return;
    const closeViewControl = () => {
      const trigger = document.querySelector<HTMLElement>(
        `[data-view-popover-trigger="${openViewControl}"]`
      );
      setOpenViewControl(null);
      return trigger;
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "[data-view-popover-control], [data-view-popover-surface]"
        )
      ) {
        return;
      }
      closeViewControl();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeViewControl()?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openViewControl]);

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

  function updateView(
    changes: Partial<HumanReviewView>,
    navigation: "replace" | "push" = "replace"
  ) {
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
    let changed = false;
    for (const key of [
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
    ]) {
      if (params.has(key)) {
        params.delete(key);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
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

  function onStatusNavigate(status: HumanReviewView["status"]) {
    return (event: { preventDefault: () => void }) => {
      event.preventDefault();
      updateViewImmediately({ status, page: 1 }, "push");
    };
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
      if (view.status !== "pending") continue;
      for (const row of mutation.rowSnapshots) {
        if (
          !baseIds.has(row.inputItemId) &&
          humanReviewRowMatchesView(row, view)
        ) {
          restored.set(row.inputItemId, row);
        }
      }
    }
    return [...restored.values()];
  }, [humanMutations, rows, view]);
  const lockedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { record, mutation } of humanMutations) {
      if (mutation.operation === "undo" && record.status !== "succeeded") {
        mutation.inputItemIds.forEach((id) => ids.add(id));
      }
    }
    return ids;
  }, [humanMutations]);

  const projectedRows = useMemo(() => {
    const projected = [...rows, ...restoredRows].filter(
      (row) => !hiddenIds.has(row.inputItemId)
    );
    return restoredRows.length > 0
      ? projected.sort((left, right) =>
          compareHumanReviewRows(left, right, view)
        )
      : projected;
  }, [hiddenIds, restoredRows, rows, view]);
  const synchronizingMutationCount = humanMutations.filter(
    ({ record }) => record.status !== "succeeded"
  ).length;
  const actionStatus =
    synchronizingMutationCount > 0
      ? `${synchronizingMutationCount} review ${synchronizingMutationCount === 1 ? "update" : "updates"} waiting to synchronize.`
      : "";
  const viewStatus = humanReviewViewAnnouncement(view);

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
                  snapshot !== undefined &&
                  (!humanReviewRowMatchesView(snapshot, view) ||
                    (row?.status === "pending" &&
                      row.currentRevision >= snapshot.currentRevision))
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
        const confirmedMessage = indeterminateSuccessMessages.current.get(
          record.id
        );
        if (confirmedMessage) {
          toast.success(confirmedMessage, { id: record.id });
          indeterminateSuccessMessages.current.delete(record.id);
        }
        successGenerations.current.delete(record.id);
        retriedCanonicalRefreshes.current.delete(record.id);
        dismiss(record.id);
      } else if (!retriedCanonicalRefreshes.current.has(record.id)) {
        retriedCanonicalRefreshes.current.add(record.id);
        router.refresh();
      }
    }
  }, [dismiss, humanMutations, router, rows, view]);

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
      setDetailDismissed(true);
      setPendingDetail(null);
      router.replace(humanReviewHref(view), { scroll: false });
    }
  };

  function closeDetail() {
    setDetailDismissed(true);
    setPendingDetail(null);
    router.push(humanReviewHref(controlViewRef.current), { scroll: false });
  }

  function enqueueHumanMutation(
    submission: HumanMutationSubmission,
    rowSnapshots: HumanReviewListRow[],
    requiresCanonicalPendingRow = submission.operation === "undo" &&
      rowSnapshots.some((row) => row.status === "pending")
  ) {
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
            currentRevision: row.currentRevision + 2
          }))
        : rowSnapshots,
      requiresCanonicalPendingRow
    };
    const feedback = mutationFeedback(submission, rowSnapshots);
    const mutationId = enqueue({
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
          toast.warning(feedback.failure(result.message), {
            id: mutationId,
            duration: Infinity
          });
          return;
        }
        successGenerations.current.set(mutationId, canonicalGeneration.current);
        if (result.operation === "answer") {
          toast.success(feedback.success, {
            id: mutationId,
            action: {
              label: "Undo",
              onClick: () => {
                dismiss(mutationId);
                toast.dismiss(mutationId);
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
        toast.success(
          result.operation === "undo" ? feedback.success : result.message,
          { id: mutationId }
        );
      },
      onIndeterminate: (_error, mutationId) => {
        successGenerations.current.set(mutationId, canonicalGeneration.current);
        indeterminateSuccessMessages.current.set(mutationId, feedback.success);
        toast.warning(feedback.indeterminate, {
          id: mutationId,
          duration: Infinity
        });
      },
      onError: (error, mutationId) => {
        indeterminateSuccessMessages.current.delete(mutationId);
        successGenerations.current.delete(mutationId);
        retriedCanonicalRefreshes.current.delete(mutationId);
        const message =
          error instanceof HumanMutationError
            ? error.message
            : "Action is temporarily unavailable.";
        toast.error(feedback.failure(message), {
          id: mutationId,
          duration: Infinity
        });
      }
    });
    toast.loading(feedback.pending, { id: mutationId });
  }

  useEffect(() => {
    if (!notice) return;
    if (consumedNoticeEpoch.current === noticeEpoch) return;
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

  return (
    <main
      ref={workspaceRef}
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
          <Link
            className={view.status === "answered" ? undefined : "active"}
            href={humanReviewHref({
              ...controlView,
              search,
              status: "pending",
              page: 1
            })}
            onNavigate={onStatusNavigate("pending")}
            aria-current={view.status === "answered" ? undefined : "page"}
          >
            Review queue
          </Link>
          <Link
            className={view.status === "answered" ? "active" : undefined}
            href={humanReviewHref({
              ...controlView,
              search,
              status: "answered",
              page: 1
            })}
            onNavigate={onStatusNavigate("answered")}
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
                <ReviewFilterControl
                  view={controlView}
                  typeOptions={typeOptions}
                  open={openViewControl === "filter"}
                  sheet={useViewControlSheet}
                  portalTarget={workspaceRef.current}
                  onOpenChange={(open) =>
                    setOpenViewControl(open ? "filter" : null)
                  }
                  onChange={(changes) =>
                    updateViewImmediately({ ...changes, page: 1 })
                  }
                />
                <ReviewSortControl
                  view={controlView}
                  open={openViewControl === "sort"}
                  sheet={useViewControlSheet}
                  portalTarget={workspaceRef.current}
                  onOpenChange={(open) =>
                    setOpenViewControl(open ? "sort" : null)
                  }
                  onChange={(changes) =>
                    updateViewImmediately({ ...changes, page: 1 })
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
            <ReviewList
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
                {view.status === "pending" ? (
                  <Link
                    href={humanReviewHref({
                      ...controlView,
                      search: "",
                      status: "answered",
                      page: 1
                    })}
                    onNavigate={(event) => {
                      event.preventDefault();
                      updateViewImmediately(
                        { search: "", status: "answered", page: 1 },
                        "push"
                      );
                    }}
                  >
                    Review answered decisions
                  </Link>
                ) : (
                  <Link
                    href={humanReviewHref({
                      ...controlView,
                      search: "",
                      status: "pending",
                      page: 1
                    })}
                    onNavigate={(event) => {
                      event.preventDefault();
                      updateViewImmediately(
                        { search: "", status: "pending", page: 1 },
                        "push"
                      );
                    }}
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
      detail &&
      (!pendingDetail || detail.inputItemId === pendingDetail.inputItemId) &&
      !hiddenIds.has(detail.inputItemId) &&
      !lockedIds.has(detail.inputItemId) ? (
        <ReviewDetail
          key={detail?.inputItemId ?? "empty"}
          detail={detail}
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
                  label: plainText(previousDetailRow.titleHtml)
                }
              : null
          }
          nextItem={
            nextDetailRow
              ? {
                  href: humanReviewHref(controlView, nextDetailRow.inputItemId),
                  label: plainText(nextDetailRow.titleHtml)
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

function ViewPopoverLayer({
  open,
  sheet,
  portalTarget,
  closeLabel,
  onClose,
  children
}: {
  open: boolean;
  sheet: boolean;
  portalTarget: HTMLElement | null;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  const layer = (
    <>
      {sheet ? (
        <button
          type="button"
          className="view-popover-scrim"
          aria-label={closeLabel}
          onClick={onClose}
        />
      ) : null}
      {children}
    </>
  );
  return sheet && portalTarget ? createPortal(layer, portalTarget) : layer;
}

function ReviewFilterControl({
  view,
  typeOptions,
  open,
  sheet,
  portalTarget,
  onOpenChange,
  onChange
}: {
  view: HumanReviewView;
  typeOptions: string[];
  open: boolean;
  sheet: boolean;
  portalTarget: HTMLElement | null;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<HumanReviewView>) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const count = view.priorities.length + view.types.length;
  const availableTypes = [...new Set([...typeOptions, ...view.types])].sort(
    compareHumanReviewTypeNames
  );
  useEffect(() => {
    if (open) popoverRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [open]);
  return (
    <div
      className={`view-control${count ? " active" : ""}${open ? " open" : ""}`}
      data-view-popover-control
    >
      <button
        type="button"
        className="view-control-trigger"
        aria-label={`Filter${count ? `, ${count} applied` : ""}`}
        aria-expanded={open}
        aria-controls="review-filter-popover"
        aria-haspopup="dialog"
        data-view-popover-trigger="filter"
        onClick={() => onOpenChange(!open)}
      >
        <Filter aria-hidden="true" />
        <span>Filter</span>
        {count ? <strong className="view-control-count">{count}</strong> : null}
        <ChevronDown aria-hidden="true" />
      </button>
      <ViewPopoverLayer
        open={open}
        sheet={sheet}
        portalTarget={portalTarget}
        closeLabel="Dismiss filter panel"
        onClose={() => onOpenChange(false)}
      >
        <div
          ref={popoverRef}
          id="review-filter-popover"
          className="view-popover filter-popover"
          role="dialog"
          aria-label="Filter reviews"
          data-view-popover-surface
        >
          <div className="view-popover-heading">
            <div>
              <strong>Filter reviews</strong>
              <span>Select any values you want to include.</span>
            </div>
            <div className="view-popover-actions">
              {count ? (
                <button
                  type="button"
                  className="view-reset-button"
                  onClick={() => onChange({ priorities: [], types: [] })}
                >
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                className="sort-icon-button view-close-button"
                aria-label="Close filter menu"
                onClick={() => onOpenChange(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          <FilterChoices
            legend="Priority"
            options={PRIORITY_FILTER_OPTIONS}
            selected={view.priorities}
            onChange={(priorities) =>
              onChange({
                priorities: priorities as HumanReviewView["priorities"]
              })
            }
          />
          <FilterChoices
            legend="Type"
            options={availableTypes.map((value) => ({ value, label: value }))}
            selected={view.types}
            emptyCopy="No review types in this view."
            onChange={(types) => onChange({ types })}
          />
          <div className="view-popover-footer">
            <button type="button" onClick={() => onOpenChange(false)}>
              Done
            </button>
          </div>
        </div>
      </ViewPopoverLayer>
    </div>
  );
}

function FilterChoices({
  legend,
  options,
  selected,
  emptyCopy,
  onChange
}: {
  legend: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: readonly string[];
  emptyCopy?: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="filter-choice-group">
      <legend>{legend}</legend>
      {options.length ? (
        <div className="filter-choice-list">
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((value) => value !== option.value)
                  )
                }
              />
              <span>{option.label}</span>
              {selected.includes(option.value) ? (
                <Check aria-hidden="true" />
              ) : null}
            </label>
          ))}
        </div>
      ) : (
        <p className="filter-empty-copy">{emptyCopy}</p>
      )}
    </fieldset>
  );
}

function ReviewSortControl({
  view,
  open,
  sheet,
  portalTarget,
  onOpenChange,
  onChange
}: {
  view: HumanReviewView;
  open: boolean;
  sheet: boolean;
  portalTarget: HTMLElement | null;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<HumanReviewView>) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousRuleCount = useRef(view.sorts.length);
  const focusRuleAfterFieldChange = useRef<number | null>(null);
  const recipe = view.sorts.map(({ key }) => sortLabel(key)).join(" → ");
  const custom = !isDefaultHumanReviewOrdering(view);
  const unusedSort = SORT_OPTIONS.find(
    (option) => !view.sorts.some((rule) => rule.key === option.value)
  )?.value;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  function moveRule(from: number, to: number) {
    if (to < 0 || to >= view.sorts.length || from === to) return;
    onChange({ sorts: arrayMove(view.sorts, from, to) });
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = view.sorts.findIndex((rule) => rule.key === event.active.id);
    const to = view.sorts.findIndex((rule) => rule.key === event.over?.id);
    if (from >= 0 && to >= 0) moveRule(from, to);
  }

  function closeAndRestoreFocus() {
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (open) popoverRef.current?.querySelector<HTMLElement>("select")?.focus();
  }, [open]);
  useEffect(() => {
    const previous = previousRuleCount.current;
    previousRuleCount.current = view.sorts.length;
    if (!open || view.sorts.length <= previous) return;
    popoverRef.current
      ?.querySelector<HTMLElement>(
        `[aria-label="Sort ${view.sorts.length} field"]`
      )
      ?.focus();
  }, [open, view.sorts.length]);
  useEffect(() => {
    const rank = focusRuleAfterFieldChange.current;
    if (!open || rank === null) return;
    focusRuleAfterFieldChange.current = null;
    popoverRef.current
      ?.querySelector<HTMLElement>(`[aria-label="Sort ${rank} field"]`)
      ?.focus();
  }, [open, view.sorts]);

  return (
    <div
      className={`view-control sort-control${custom ? " active" : ""}${open ? " open" : ""}`}
      data-view-popover-control
    >
      <button
        ref={triggerRef}
        type="button"
        className="view-control-trigger"
        aria-label={`Sort: ${recipe}`}
        aria-expanded={open}
        aria-controls="review-sort-popover"
        aria-haspopup="dialog"
        data-view-popover-trigger="sort"
        onClick={() => onOpenChange(!open)}
      >
        <span>Sort</span>
        <strong>{recipe}</strong>
        <ChevronDown aria-hidden="true" />
      </button>
      <ViewPopoverLayer
        open={open}
        sheet={sheet}
        portalTarget={portalTarget}
        closeLabel="Dismiss sort panel"
        onClose={closeAndRestoreFocus}
      >
        <div
          ref={popoverRef}
          id="review-sort-popover"
          className="view-popover sort-popover"
          role="dialog"
          aria-label="Sort reviews"
          data-view-popover-surface
        >
          <div className="view-popover-heading">
            <div>
              <strong>Sort order</strong>
              <span>
                {view.sorts.length > 1
                  ? "Drag rules into priority order."
                  : "Choose how the queue should be ordered."}
              </span>
            </div>
            <div className="view-popover-actions">
              {custom ? (
                <button
                  type="button"
                  className="view-reset-button"
                  onClick={() =>
                    onChange({ sorts: [{ key: "priority", direction: "asc" }] })
                  }
                >
                  <RotateCcw aria-hidden="true" /> Reset
                </button>
              ) : null}
              <button
                type="button"
                className="sort-done-button"
                onClick={closeAndRestoreFocus}
              >
                Done
              </button>
            </div>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  "Drag to reorder with a pointer, or use Arrow Up and Arrow Down while this handle is focused."
              },
              announcements: {
                onDragStart: ({ active }) =>
                  `Picked up ${sortLabel(active.id as HumanReviewSort)} sort.`,
                onDragOver: ({ active, over }) =>
                  over
                    ? `${sortLabel(active.id as HumanReviewSort)} is over ${sortLabel(over.id as HumanReviewSort)}.`
                    : undefined,
                onDragEnd: ({ active, over }) =>
                  over
                    ? `Placed ${sortLabel(active.id as HumanReviewSort)} at ${sortLabel(over.id as HumanReviewSort)} position.`
                    : `Dropped ${sortLabel(active.id as HumanReviewSort)} without changing its position.`,
                onDragCancel: ({ active }) =>
                  `Cancelled moving ${sortLabel(active.id as HumanReviewSort)}.`
              }
            }}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={view.sorts.map((rule) => rule.key)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="sort-rule-list">
                {view.sorts.map((rule, index) => (
                  <SortRule
                    key={rule.key}
                    rank={index + 1}
                    total={view.sorts.length}
                    sort={rule.key}
                    direction={rule.direction}
                    excluded={view.sorts
                      .filter((_, ruleIndex) => ruleIndex !== index)
                      .map(({ key }) => key)}
                    onSortChange={(key) => {
                      focusRuleAfterFieldChange.current = index + 1;
                      const sorts = [...view.sorts];
                      sorts[index] = {
                        key,
                        direction: defaultHumanReviewSortDirection(key)
                      };
                      onChange({ sorts });
                    }}
                    onDirectionChange={(direction) => {
                      const sorts = [...view.sorts];
                      sorts[index] = { ...rule, direction };
                      onChange({ sorts });
                    }}
                    onMove={(offset) => moveRule(index, index + offset)}
                    onRemove={
                      view.sorts.length > 1
                        ? () =>
                            onChange({
                              sorts: view.sorts.filter(
                                (_, ruleIndex) => ruleIndex !== index
                              )
                            })
                        : undefined
                    }
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          {unusedSort ? (
            <button
              type="button"
              className="add-sort-button"
              onClick={() =>
                onChange({
                  sorts: [
                    ...view.sorts,
                    {
                      key: unusedSort,
                      direction: defaultHumanReviewSortDirection(unusedSort)
                    }
                  ]
                })
              }
            >
              <Plus aria-hidden="true" /> Add sort field
            </button>
          ) : null}
          {view.sorts.some((rule) => rule.key === "visual_score") ? (
            <p className="sort-null-copy">
              <span aria-hidden="true">↓</span>
              Reviews without a numeric score stay at the bottom.
            </p>
          ) : null}
        </div>
      </ViewPopoverLayer>
    </div>
  );
}

function SortRule({
  rank,
  total,
  sort,
  direction,
  excluded,
  onSortChange,
  onDirectionChange,
  onMove,
  onRemove
}: {
  rank: number;
  total: number;
  sort: HumanReviewSort;
  direction: HumanReviewSortDirection;
  excluded: HumanReviewSort[];
  onSortChange: (sort: HumanReviewSort) => void;
  onDirectionChange: (direction: HumanReviewSortDirection) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging
  } = useSortable({ id: sort, disabled: total < 2 });
  const style = {
    "--sort-rule-transform": CSS.Transform.toString(transform) ?? "none"
  } as CSSProperties;

  return (
    <li
      ref={setNodeRef}
      className={`sort-rule${isDragging ? " dragging" : ""}`}
      style={style}
    >
      <div className="sort-rule-row">
        <span className="sort-rank" aria-hidden="true">
          {rank}
        </span>
        {total > 1 ? (
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="sort-drag-handle"
            aria-label={`Reorder ${sortLabel(sort)} sort, position ${rank} of ${total}`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            {...attributes}
            {...listeners}
            onKeyDown={(event) => {
              const offset =
                event.key === "ArrowUp"
                  ? -1
                  : event.key === "ArrowDown"
                    ? 1
                    : 0;
              if (!offset || rank + offset < 1 || rank + offset > total) return;
              event.preventDefault();
              onMove(offset);
            }}
          >
            <GripVertical aria-hidden="true" />
          </button>
        ) : (
          <span className="sort-drag-placeholder" aria-hidden="true" />
        )}
        <div className="sort-rule-fields">
          <SortSelect
            ariaLabel={`Sort ${rank} field`}
            value={sort}
            options={SORT_OPTIONS.filter(
              (option) => !excluded.includes(option.value)
            )}
            onChange={(value) => onSortChange(value as HumanReviewSort)}
          />
          <SortSelect
            className="sort-direction-select"
            ariaLabel={`Sort ${rank} direction`}
            value={direction}
            options={(["asc", "desc"] as const).map((value) => ({
              value,
              label: sortDirectionLabel(sort, value)
            }))}
            onChange={(value) =>
              onDirectionChange(value as HumanReviewSortDirection)
            }
          />
        </div>
        {onRemove ? (
          <button
            type="button"
            className="sort-remove-button"
            onClick={onRemove}
            aria-label={`Remove ${sortLabel(sort)} sort`}
          >
            <X aria-hidden="true" />
          </button>
        ) : (
          <span className="sort-remove-placeholder" aria-hidden="true" />
        )}
      </div>
    </li>
  );
}

function SortSelect({
  className,
  ariaLabel,
  value,
  options,
  onChange
}: {
  className?: string;
  ariaLabel: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`sort-select${className ? ` ${className}` : ""}`}>
      <span className="sr-only">{ariaLabel}</span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" />
    </label>
  );
}

function ActiveFilterChips({
  view,
  onChange
}: {
  view: HumanReviewView;
  onChange: (changes: Partial<HumanReviewView>) => void;
}) {
  if (view.priorities.length === 0 && view.types.length === 0) return null;
  return (
    <div
      className="active-filter-chips"
      role="group"
      aria-label="Applied filters"
    >
      <span>Showing</span>
      {view.priorities.map((priority) => (
        <button
          key={priority}
          type="button"
          onClick={() =>
            onChange({
              priorities: view.priorities.filter((value) => value !== priority)
            })
          }
          aria-label={`Remove Priority: ${titleCase(priority)} filter`}
        >
          Priority: {titleCase(priority)} <X aria-hidden="true" />
        </button>
      ))}
      {view.types.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() =>
            onChange({ types: view.types.filter((value) => value !== type) })
          }
          aria-label={`Remove Type: ${type} filter`}
        >
          Type: {type} <X aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        className="clear-filter-chips"
        onClick={() => onChange({ priorities: [], types: [] })}
      >
        Clear all
      </button>
    </div>
  );
}

function sortLabel(sort: HumanReviewSort) {
  return SORT_OPTIONS.find((option) => option.value === sort)?.label ?? sort;
}

function sortDirectionLabel(
  sort: HumanReviewSort,
  direction: HumanReviewSortDirection
) {
  if (sort === "priority")
    return direction === "asc" ? "Urgent first" : "Low first";
  if (sort === "type" || sort === "title" || sort === "caller")
    return direction === "asc" ? "A–Z" : "Z–A";
  if (sort === "visual_score")
    return direction === "asc" ? "Low to high" : "High to low";
  return direction === "desc" ? "Newest first" : "Oldest first";
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
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

function matchesReviewSearch(row: HumanReviewListRow, search: string) {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return [
    plainText(row.titleHtml),
    plainText(row.subtitleHtml),
    plainText(row.summaryHtml),
    row.callerItemId,
    row.rowType.display,
    row.caller.displayName
  ].some((value) => value.toLowerCase().includes(term));
}

function humanReviewRowMatchesView(
  row: HumanReviewListRow,
  view: HumanReviewView
) {
  return (
    view.status === "pending" &&
    humanReviewMatchesFacets(row, view) &&
    matchesReviewSearch(row, view.search)
  );
}

function mutationFeedback(
  submission: HumanMutationSubmission,
  rowSnapshots: HumanReviewListRow[]
) {
  const subject =
    normalizedFormText(submission.formData, "noticeSubject") ??
    (rowSnapshots.length === 1
      ? plainText(rowSnapshots[0]?.titleHtml ?? "")
      : null);
  const action = normalizedFormText(submission.formData, "noticeAction");
  const quotedSubject = subject ? `“${subject}”` : "this review";

  if (submission.operation === "undo") {
    return {
      pending: `Restoring ${quotedSubject}…`,
      success: `Restored ${quotedSubject} to its prior queue position.`,
      indeterminate: `Still confirming the restore for ${quotedSubject}.`,
      failure: (message: string) =>
        `Could not restore ${quotedSubject}: ${message}`
    };
  }
  if (submission.operation === "bulk-answer") {
    const count = submission.inputItemIds.length;
    return {
      pending: `Saving ${count} ${count === 1 ? "review" : "reviews"}…`,
      success: `Saved ${count} ${count === 1 ? "review" : "reviews"}.`,
      indeterminate: `Still confirming ${count} ${count === 1 ? "review" : "reviews"}.`,
      failure: (message: string) => message
    };
  }
  const actionCopy = action ? `${action} for ` : "response for ";
  return {
    pending: `Saving ${actionCopy}${quotedSubject}…`,
    success: `Saved ${actionCopy}${quotedSubject}.`,
    indeterminate: `Still confirming ${actionCopy}${quotedSubject}.`,
    failure: (message: string) => `Could not save ${quotedSubject}: ${message}`
  };
}

function normalizedFormText(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 160) : null;
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
