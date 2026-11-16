"use client";

import {
  isAsOf,
  isHumanMutationOperation,
  type HumanMutationFailure,
  type HumanMutationOperation,
  type HumanMutationResult,
  type HumanMutationState,
  type HumanUndoTarget
} from "../../shared/human-mutation.ts";

export const HUMAN_MUTATION_SCOPE = "human-review";
export const HUMAN_MUTATION_TIMEOUT_MS = 20_000;
// Waits before the second and third attempts of a mutation whose outcome the
// first attempt could not establish.
export const HUMAN_MUTATION_RETRY_DELAYS_MS = [1_000, 3_000];

export class HumanMutationError extends Error {
  readonly result: HumanMutationFailure | null;
  // No attempt established whether the mutation committed.
  readonly unconfirmed: boolean;
  // Answers of a bulk request that some attempt reported as committed.
  readonly committed: HumanUndoTarget[];

  constructor(
    message: string,
    result: HumanMutationFailure | null = null,
    unconfirmed = false,
    committed: HumanUndoTarget[] = result?.undo ?? []
  ) {
    super(message);
    this.name = "HumanMutationError";
    this.result = result;
    this.unconfirmed = unconfirmed;
    this.committed = committed;
  }
}

/**
 * Sends one mutation and resolves or rejects with its definite outcome. An
 * attempt that cannot say whether the mutation committed (timeout, network
 * failure, server error) is repeated under the same mutation id, which the
 * server answers with the original result instead of applying it twice.
 */
export async function synchronizeHumanMutation(
  operation: HumanMutationOperation,
  formData: FormData
) {
  formData.set("_operation", operation);
  formData.set("mutationId", crypto.randomUUID());
  // What any attempt reported as committed stays committed, whatever a
  // later attempt goes on to report.
  const committed = new Map<string, HumanUndoTarget>();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sendHumanMutation(formData);
    } catch (error) {
      const delay = HUMAN_MUTATION_RETRY_DELAYS_MS[attempt];
      if (!(error instanceof HumanMutationError)) throw error;
      for (const target of error.committed) {
        committed.set(target.inputItemId, target);
      }
      if (error.unconfirmed && delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      // A refusal on a repeat says what that attempt did, and settles nothing
      // about an earlier attempt that may have committed.
      throw new HumanMutationError(
        error.message,
        error.result,
        error.unconfirmed || attempt > 0,
        [...committed.values()]
      );
    }
  }
}

async function sendHumanMutation(formData: FormData) {
  let response: Response;
  try {
    response = await fetch("/human/mutations", {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      signal: AbortSignal.timeout(HUMAN_MUTATION_TIMEOUT_MS)
    });
  } catch {
    throw new HumanMutationError(
      "Agent Outbox could not be reached. Check your connection and try again.",
      null,
      true
    );
  }
  if (response.redirected || response.status === 401) {
    throw new HumanMutationError(
      "Your session expired. Sign in again, then retry the action."
    );
  }
  const serverError = response.status >= 500;
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    // The body was cut off or is not a result. Unless the server refused the
    // request, the mutation may have committed.
    throw new HumanMutationError(
      "Action is temporarily unavailable.",
      null,
      response.ok || serverError
    );
  }
  if (!isHumanMutationResult(result)) {
    // A successful status without a usable result says nothing about the
    // outcome either.
    throw new HumanMutationError(
      "Action is temporarily unavailable.",
      null,
      response.ok || serverError
    );
  }
  if (!result.ok) {
    throw new HumanMutationError(result.message, result, serverError);
  }
  if (!response.ok) {
    throw new HumanMutationError("Action is temporarily unavailable.");
  }
  return result;
}

export function isHumanMutationResult(
  value: unknown
): value is HumanMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const inputItemIds = result.inputItemIds;
  const base =
    typeof result.ok === "boolean" &&
    isHumanMutationOperation(result.operation) &&
    typeof result.message === "string" &&
    Array.isArray(inputItemIds) &&
    inputItemIds.every((id) => typeof id === "string");
  if (!base || !Array.isArray(inputItemIds)) return false;
  if (!result.ok) {
    return (
      typeof result.code === "string" &&
      (result.state === undefined ||
        isHumanMutationState(result.state, inputItemIds)) &&
      (result.undo === undefined ||
        (Array.isArray(result.undo) &&
          result.undo.every(
            (target) =>
              isHumanUndoTarget(target) &&
              inputItemIds.includes(target.inputItemId)
          )))
    );
  }
  if (!isHumanMutationState(result.state, inputItemIds)) return false;
  if (result.operation === "answer") {
    return inputItemIds.length === 1 && isHumanUndoTarget(result.undo);
  }
  if (result.operation === "bulk-answer") {
    const answeredInputItemIds = result.answeredInputItemIds;
    const undo = result.undo;
    return (
      typeof result.answered === "number" &&
      Number.isFinite(result.answered) &&
      Array.isArray(answeredInputItemIds) &&
      answeredInputItemIds.length === result.answered &&
      answeredInputItemIds.every((id) => inputItemIds.includes(id)) &&
      typeof result.failed === "number" &&
      Number.isFinite(result.failed) &&
      Array.isArray(undo) &&
      undo.length === answeredInputItemIds.length &&
      undo.every(
        (target, index) =>
          isHumanUndoTarget(target) &&
          target.inputItemId === answeredInputItemIds[index]
      )
    );
  }
  const restoredInputItemIds = result.restoredInputItemIds;
  return (
    inputItemIds.length > 0 &&
    new Set(inputItemIds).size === inputItemIds.length &&
    Array.isArray(restoredInputItemIds) &&
    restoredInputItemIds.length > 0 &&
    new Set(restoredInputItemIds).size === restoredInputItemIds.length &&
    restoredInputItemIds.every((id) => inputItemIds.includes(id)) &&
    result.failed === inputItemIds.length - restoredInputItemIds.length
  );
}

// One entry per requested item, each either absent or that item's row.
function isHumanMutationState(
  value: unknown,
  inputItemIds: string[]
): value is HumanMutationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const items = state.items;
  return (
    isAsOf(state.asOf) &&
    Array.isArray(items) &&
    items.length === inputItemIds.length &&
    items.every((item: unknown, index) => {
      if (!item || typeof item !== "object") return false;
      const { inputItemId, row } = item as Record<string, unknown>;
      return (
        inputItemId === inputItemIds[index] &&
        (row === null ||
          (typeof row === "object" &&
            (row as Record<string, unknown>).inputItemId === inputItemId))
      );
    })
  );
}

function isHumanUndoTarget(value: unknown): value is HumanUndoTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.inputItemId === "string" &&
    typeof target.callerId === "string" &&
    typeof target.outputResultId === "string"
  );
}
