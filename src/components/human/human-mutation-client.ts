"use client";

import type {
  HumanMutationFailure,
  HumanMutationOperation,
  HumanMutationResult
} from "../../shared/human-mutation";
import type { HumanReviewListRow } from "../../server/human-review";

export const HUMAN_MUTATION_SCOPE = "human-review";
export const HUMAN_MUTATION_TIMEOUT_MS = 20_000;

export type HumanOptimisticMutation = {
  operation: HumanMutationOperation;
  inputItemIds: string[];
  rowSnapshots: HumanReviewListRow[];
  requiresCanonicalPendingRow: boolean;
};

export class HumanMutationError extends Error {
  readonly result: HumanMutationFailure | null;

  constructor(message: string, result: HumanMutationFailure | null = null) {
    super(message);
    this.name = "HumanMutationError";
    this.result = result;
  }
}

export async function synchronizeHumanMutation(
  operation: HumanMutationOperation,
  formData: FormData
) {
  formData.set("_operation", operation);
  const response = await fetch("/human/mutations", {
    method: "POST",
    body: formData,
    credentials: "same-origin",
    signal: AbortSignal.timeout(HUMAN_MUTATION_TIMEOUT_MS)
  });
  if (response.redirected || response.status === 401) {
    throw new HumanMutationError(
      "Your session expired. Sign in again, then retry the action."
    );
  }
  const result = (await response.json().catch(() => null)) as unknown;
  if (!isHumanMutationResult(result)) {
    throw new HumanMutationError("Action is temporarily unavailable.");
  }
  if (!result.ok) {
    throw new HumanMutationError(result.message, result);
  }
  if (!response.ok) {
    throw new HumanMutationError("Action is temporarily unavailable.");
  }
  return result;
}

export function isHumanOptimisticMutation(
  value: unknown
): value is HumanOptimisticMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mutation = value as Partial<HumanOptimisticMutation>;
  return (
    (mutation.operation === "answer" ||
      mutation.operation === "bulk-answer" ||
      mutation.operation === "undo") &&
    Array.isArray(mutation.inputItemIds) &&
    mutation.inputItemIds.every((id) => typeof id === "string") &&
    Array.isArray(mutation.rowSnapshots) &&
    typeof mutation.requiresCanonicalPendingRow === "boolean"
  );
}

export function isHumanMutationResult(
  value: unknown
): value is HumanMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const inputItemIds = result.inputItemIds;
  const base =
    typeof result.ok === "boolean" &&
    (result.operation === "answer" ||
      result.operation === "bulk-answer" ||
      result.operation === "undo") &&
    typeof result.message === "string" &&
    Array.isArray(inputItemIds) &&
    inputItemIds.every((id) => typeof id === "string");
  if (!base || !Array.isArray(inputItemIds)) return false;
  if (!result.ok) return typeof result.code === "string";
  if (result.operation === "answer") {
    const undo = result.undo as Record<string, unknown> | undefined;
    return (
      inputItemIds.length === 1 &&
      !!undo &&
      typeof undo.inputItemId === "string" &&
      typeof undo.callerId === "string" &&
      typeof undo.outputResultId === "string"
    );
  }
  if (result.operation === "bulk-answer") {
    return (
      typeof result.answered === "number" &&
      Number.isFinite(result.answered) &&
      typeof result.failed === "number" &&
      Number.isFinite(result.failed)
    );
  }
  return inputItemIds.length === 1;
}
