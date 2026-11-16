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
  humanReviewViewFromSearchParams,
  writeHumanReviewView,
  type HumanReviewView
} from "../../shared/human-review-view";
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
  synchronizeHumanMutation
} from "./human-mutation-client";
import {
  itemIdsNotPending,
  projectReview,
  recordItemStates,
  reviewDetailSuperseded,
  type ReviewItemStates,
  type UnsettledReviewMutation
} from "./review-sync";
import {
  confirmUndoEntry,
  offeredUndoEntry,
  patchUndoEntry,
  removeUndoEntry,
  removeUndoTargets,
  settleUndoEntry,
  undoAvailable,
  type UndoEntry
} from "./undo-stack";
import {
  isApplePlatform,
  isUndoShortcut,
  keepsUndoShortcut
} from "./undo-shortcut";
import type {
  HumanMutationState,
  HumanUndoTarget
} from "../../shared/human-mutation";

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
  asOf,
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
  // Orders these rows against mutation responses; see review-sync.
  asOf: string;
  detailOpen: boolean;
  composeAction?: string | null;
  renderedAt: string;
}) {
  const router = useRouter();
  const feedback = useFeedbackDrafts(session.accountId, session.userId);
  const { mutations, currentMutations, enqueue } = useAppActions();
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
  const [undoStack, setUndoStack] = useState<UndoEntry[]>(() =>
    undoStackFromNotice(notice)
  );
  // Settlement callbacks outlive the render that enqueued them, so they read
  // and write the stack through this ref instead of a captured state value.
  const undoStackRef = useRef(undoStack);
  const nextUndoEntryId = useRef(0);
  const startUndoRef = useRef<(entryId: string) => void>(() => {});
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
  const [itemStates, setItemStates] = useState<ReviewItemStates>(
    () => new Map()
  );
  const asOfRef = useRef(asOf);
  asOfRef.current = asOf;
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

  const unsettled = useMemo(
    () =>
      mutations.flatMap((record) =>
        record.scope === HUMAN_MUTATION_SCOPE
          ? [record.optimistic as UnsettledReviewMutation]
          : []
      ),
    [mutations]
  );
  const { rows: projectedRows, lockedIds } = useMemo(
    () => projectReview({ rows, asOf }, itemStates, unsettled, view),
    [asOf, itemStates, rows, unsettled, view]
  );
  const actionStatus =
    unsettled.length > 0
      ? `${unsettled.length} review ${unsettled.length === 1 ? "update" : "updates"} waiting to synchronize.`
      : "";
  const offeredUndo = offeredUndoEntry(undoStack);
  const viewStatus = humanReviewViewAnnouncement(view);
  const otherStatus = view.status === "pending" ? "answered" : "pending";

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
      // The latest requested view, so a filter change still loading is kept.
      router.replace(humanReviewHref(controlViewRef.current), {
        scroll: false
      });
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

  // Stores what the server reported about the items of one mutation.
  function applyServerState(state: HumanMutationState) {
    setItemStates((current) =>
      recordItemStates(current, state, asOfRef.current)
    );
    deselect(new Set(itemIdsNotPending(state)));
  }

  function enqueueHumanMutation(
    submission: HumanMutationSubmission,
    rowSnapshots: HumanReviewListRow[],
    // The stack entry this undo reverses; absent for an undo from History.
    undoEntryId: string | null = null
  ) {
    // Repeated activation before the optimistic projection renders would send
    // the same items again; once settled, they are submittable again.
    const unsettledIds = new Set(
      currentMutations().flatMap((record) =>
        record.scope === HUMAN_MUTATION_SCOPE
          ? (record.optimistic as UnsettledReviewMutation).inputItemIds
          : []
      )
    );
    if (submission.inputItemIds.every((id) => unsettledIds.has(id))) {
      return false;
    }
    const answering = submission.operation !== "undo";
    if (answering) {
      for (const id of submission.inputItemIds) {
        submission.formData.set(
          submission.operation === "answer" ? "feedback" : `feedback.${id}`,
          feedback.drafts[id] ?? ""
        );
      }
      setLastError(null);
    }
    if (notice) {
      consumedNoticeEpoch.current = noticeEpoch;
    }
    clearRedirectNoticeFromUrl();
    const optimistic: UnsettledReviewMutation = {
      operation: submission.operation,
      inputItemIds: submission.inputItemIds,
      rowSnapshots: answering ? [] : rowSnapshots
    };
    // Every answer joins the stack when the person acts, not when the server
    // replies, so Undo always targets their most recent action.
    const answerEntryId = answering
      ? `undo-entry-${++nextUndoEntryId.current}`
      : null;
    if (answerEntryId) {
      updateUndoStack((stack) => [
        ...stack,
        {
          id: answerEntryId,
          actionLabel: normalizedFormText(submission.formData, "noticeAction"),
          inputItemIds: submission.inputItemIds,
          targets: null,
          rowSnapshots,
          undoRequested: false,
          undoing: false
        }
      ]);
    }
    function confirmAnswerEntry(targets: HumanUndoTarget[]) {
      if (!answerEntryId) return;
      updateUndoStack((stack) =>
        confirmUndoEntry(stack, answerEntryId, targets)
      );
      if (
        undoStackRef.current.find((entry) => entry.id === answerEntryId)
          ?.undoRequested
      ) {
        startUndoRef.current(answerEntryId);
      }
    }
    // Answers the server reports as committed: their sent feedback is done
    // with, and the stack entry narrows to them (or goes, when there are none).
    function answersCommitted(answered: HumanUndoTarget[]) {
      for (const { inputItemId } of answered) {
        const sent = submission.formData.get(
          submission.operation === "answer"
            ? "feedback"
            : `feedback.${inputItemId}`
        );
        if (typeof sent === "string") {
          feedback.clearSubmitted(inputItemId, sent);
        }
      }
      confirmAnswerEntry(answered);
    }
    // The submitted answers can no longer be undone from here: drop the stack
    // entry, or for an undo from History, the matching answers in any entry.
    function forgetUndoneAnswers() {
      if (undoEntryId) {
        updateUndoStack((stack) => removeUndoEntry(stack, undoEntryId));
        return;
      }
      updateUndoStack((stack) =>
        removeUndoTargets(
          stack,
          submission.inputItemIds,
          normalizedFormText(submission.formData, "outputResultId")
        )
      );
    }
    enqueue({
      scope: HUMAN_MUTATION_SCOPE,
      optimistic,
      execute: () =>
        synchronizeHumanMutation(submission.operation, submission.formData),
      refreshOnSettle: true,
      onSuccess: (result) => {
        applyServerState(result.state);
        if (result.operation === "undo") {
          if (undoEntryId) {
            // Answers a partial undo could not restore stay on the stack
            // while the server still holds them unread.
            updateUndoStack((stack) =>
              settleUndoEntry(stack, undoEntryId, result.state)
            );
          } else {
            forgetUndoneAnswers();
          }
          setLastError(result.failed > 0 ? result.message : null);
          return;
        }
        answersCommitted(
          result.operation === "answer" ? [result.undo] : result.undo
        );
        setLastError(
          result.operation === "bulk-answer" && result.failed > 0
            ? result.message
            : null
        );
      },
      onError: (error) => {
        const failure =
          error instanceof HumanMutationError ? error.result : null;
        if (failure?.state) applyServerState(failure.state);
        if (answerEntryId) {
          // A bulk answer stopped part-way keeps Undo for what it committed.
          answersCommitted(failure?.undo ?? []);
        } else if (undoEntryId && failure?.state) {
          // The reported rows say which answers can still be undone.
          const { state } = failure;
          updateUndoStack((stack) =>
            settleUndoEntry(stack, undoEntryId, state)
          );
        } else if (
          failure?.code === "output_already_read" ||
          failure?.code === "not_found"
        ) {
          // These undo rejections are permanent; retrying cannot succeed.
          forgetUndoneAnswers();
        } else if (undoEntryId) {
          // Offer the same action again for a retry.
          updateUndoStack((stack) =>
            patchUndoEntry(stack, undoEntryId, { undoing: false })
          );
        }
        setLastError(
          mutationFailureMessage(
            submission,
            rowSnapshots,
            error instanceof HumanMutationError
              ? error.message
              : "Action is temporarily unavailable.",
            error instanceof HumanMutationError && error.unconfirmed
          )
        );
      }
    });
    return true;
  }

  function updateUndoStack(update: (stack: UndoEntry[]) => UndoEntry[]) {
    const next = update(undoStackRef.current);
    undoStackRef.current = next;
    setUndoStack(next);
  }

  function startUndo(entryId: string) {
    const entry = undoStackRef.current.find(
      (candidate) => candidate.id === entryId
    );
    if (!entry || entry.undoing) return;
    const { targets } = entry;
    if (!targets) {
      // The answer is still saving. Undo starts as soon as it is accepted.
      updateUndoStack((stack) =>
        patchUndoEntry(stack, entryId, { undoRequested: true })
      );
      return;
    }
    const formData = new FormData();
    for (const target of targets) {
      formData.append("inputItemId", target.inputItemId);
      formData.append("callerId", target.callerId);
      formData.append("outputResultId", target.outputResultId);
    }
    const undoing = enqueueHumanMutation(
      {
        operation: "undo",
        inputItemIds: targets.map((target) => target.inputItemId),
        formData
      },
      entry.rowSnapshots,
      entryId
    );
    updateUndoStack((stack) =>
      patchUndoEntry(stack, entryId, { undoRequested: false, undoing })
    );
  }
  startUndoRef.current = startUndo;
  const lockedIdsRef = useRef(lockedIds);
  lockedIdsRef.current = lockedIds;

  // What the Undo control and its shortcut both do: undo the offered action
  // unless that is unavailable. Locks are read as they are now, including
  // undos started since the last render. Returns whether an undo started.
  function requestUndo() {
    const stack = undoStackRef.current;
    const entry = offeredUndoEntry(stack);
    const locked = new Set(lockedIdsRef.current);
    for (const other of stack) {
      if (other.undoing) other.inputItemIds.forEach((id) => locked.add(id));
    }
    if (!entry || !undoAvailable(entry, locked)) return false;
    startUndo(entry.id);
    return true;
  }
  const requestUndoRef = useRef(requestUndo);
  requestUndoRef.current = requestUndo;

  // The platform's undo shortcut presses the Undo control. A text field keeps
  // its own undo, an open dialog or panel keeps the keyboard, and a held key
  // undoes once.
  useEffect(() => {
    const applePlatform = isApplePlatform(navigator.userAgent);
    function undoByKeyboard(event: KeyboardEvent) {
      if (
        !isUndoShortcut(event, applePlatform) ||
        event.repeat ||
        event.isComposing ||
        event.defaultPrevented ||
        keepsUndoShortcut(event.target) ||
        // A modal makes the page behind it inert even when focus is on
        // neither; the filter and sort panels are this workspace's own.
        document.querySelector("dialog:modal, [data-view-popover-surface]")
      ) {
        return;
      }
      if (requestUndoRef.current()) event.preventDefault();
    }

    window.addEventListener("keydown", undoByKeyboard);
    return () => window.removeEventListener("keydown", undoByKeyboard);
  }, []);

  useEffect(() => {
    if (!notice) return;
    if (consumedNoticeEpoch.current === noticeEpoch) return;
    consumedNoticeEpoch.current = noticeEpoch;
    const noticeUndo = undoStackFromNotice(notice);
    if (noticeUndo.length > 0) {
      updateUndoStack((stack) => (stack.length > 0 ? stack : noticeUndo));
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
      data-review-mutation-count={unsettled.length}
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
            {offeredUndo ? (
              <LastAnswerUndoForm
                key={offeredUndo.id}
                undo={offeredUndo}
                disabled={!undoAvailable(offeredUndo, lockedIds)}
                onUndo={requestUndo}
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
        !reviewDetailSuperseded(detail, asOf, itemStates, unsettled)) ? (
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

// A redirecting (JavaScript-disabled) answer reports its undo target in the
// notice; it seeds the stack when the workspace then hydrates.
function undoStackFromNotice(notice: HumanReviewNotice | null): UndoEntry[] {
  if (!notice?.undo) return [];
  return [
    {
      id: `undo-notice-${notice.undo.outputResultId}`,
      actionLabel: notice.actionLabel ?? null,
      inputItemIds: [notice.undo.inputItemId],
      targets: [notice.undo],
      rowSnapshots: [],
      undoRequested: false,
      undoing: false
    }
  ];
}

function mutationFailureMessage(
  submission: HumanMutationSubmission,
  rowSnapshots: HumanReviewListRow[],
  message: string,
  // No attempt reported an outcome, so the mutation may have committed.
  unconfirmed: boolean
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
    const restored =
      submission.inputItemIds.length > 1
        ? `${submission.inputItemIds.length} reviews`
        : quotedSubject;
    return unconfirmed
      ? `${restored} may not have been restored: ${message}`
      : `Could not restore ${restored}: ${message}`;
  }
  return unconfirmed
    ? `${quotedSubject} may not have been saved: ${message}`
    : `Could not save ${quotedSubject}: ${message}`;
}

function normalizedFormText(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 160) : null;
}
