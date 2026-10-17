"use client";

import { useCallback, useEffect, useState } from "react";

import type { HumanReviewListRow } from "../../server/human-review.ts";

type PersistedWorkspaceState = {
  selectedIds?: unknown;
  skippedIds?: unknown;
};

const WORKSPACE_STATE_KEY_PREFIX = "agent-outbox:human-review-workspace:v1";
const WORKSPACE_ID_LIMIT = 100;
export function useReviewSelection(
  accountId: string,
  rows: HumanReviewListRow[]
) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [hydratedAccountId, setHydratedAccountId] = useState<string | null>(
    null
  );
  useEffect(() => {
    const persisted = readWorkspaceState(accountId);
    setSelectedIds(new Set(persisted?.selectedIds ?? []));
    setSkippedIds(new Set(persisted?.skippedIds ?? []));
    setSelectionMode((persisted?.selectedIds.length ?? 0) > 0);
    setHydratedAccountId(accountId);
  }, [accountId]);

  useEffect(() => {
    if (hydratedAccountId !== accountId) {
      return;
    }
    writeWorkspaceState(accountId, {
      selectedIds: [...selectedIds],
      skippedIds: [...skippedIds]
    });
  }, [hydratedAccountId, selectedIds, accountId, skippedIds]);

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

  const setRowSelected = useCallback(
    (inputItemId: string, selected: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (selected) {
          addBoundedId(next, inputItemId);
        } else {
          next.delete(inputItemId);
        }
        return next;
      });
    },
    []
  );

  const toggleSkipped = useCallback((inputItemId: string) => {
    setSkippedIds((current) => {
      const next = new Set(current);
      if (next.has(inputItemId)) {
        next.delete(inputItemId);
      } else {
        addBoundedId(next, inputItemId);
      }
      return next;
    });
  }, []);

  function toggleSelectionMode() {
    if (selectionMode) {
      setSelectedIds(new Set());
    }
    setSelectionMode((current) => !current);
  }

  const deselect = useCallback((ids: Set<string>) => {
    setSelectedIds((current) => removeIds(current, ids));
  }, []);

  return {
    selectedIds,
    skippedIds,
    selectionMode,
    hydrated: hydratedAccountId === accountId,
    setRowSelected,
    toggleSkipped,
    toggleSelectionMode,
    deselect
  };
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
