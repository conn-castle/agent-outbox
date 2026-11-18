"use client";

import {
  bulkAnswerMessage,
  isAsOf,
  isHumanMutationOperation,
  type HumanBulkMutationSuccess,
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
  // The newest item state any attempt reported.
  readonly state: HumanMutationState | null;

  constructor(
    message: string,
    result: HumanMutationFailure | null = null,
    unconfirmed = false,
    committed: HumanUndoTarget[] = result?.undo ?? [],
    state: HumanMutationState | null = result?.state ?? null
  ) {
    super(message);
    this.name = "HumanMutationError";
    this.result = result;
    this.unconfirmed = unconfirmed;
    this.committed = committed;
    this.state = state;
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
  formData.set("mutationId", newMutationId());
  // What any attempt reported as committed stays committed, whatever a
  // later attempt goes on to report.
  const committed = new Map<string, HumanUndoTarget>();
  // Each attempt's state covers every item of the request and is read after
  // the previous attempt's, so the latest one reported is the newest.
  let state: HumanMutationState | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await sendHumanMutation(formData);
      return result.operation === "bulk-answer"
        ? withEarlierAnswers(result, committed)
        : result;
    } catch (error) {
      const delay = HUMAN_MUTATION_RETRY_DELAYS_MS[attempt];
      if (!(error instanceof HumanMutationError)) throw error;
      for (const target of error.committed) {
        committed.set(target.inputItemId, target);
      }
      state = error.state ?? state;
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
        [...committed.values()],
        state
      );
    }
  }
}

// `crypto.randomUUID` exists only in secure contexts. A page served over
// plain HTTP from another host, as a self-hosted one can be, still has
// `getRandomValues`.
function newMutationId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

// A repeat cannot always report again what an earlier attempt answered: by
// then the answer may be gone, acknowledged by its caller. It still counts.
function withEarlierAnswers(
  result: HumanBulkMutationSuccess,
  committed: ReadonlyMap<string, HumanUndoTarget>
): HumanBulkMutationSuccess {
  const undo = result.inputItemIds.flatMap(
    (inputItemId) =>
      result.undo.find((target) => target.inputItemId === inputItemId) ??
      committed.get(inputItemId) ??
      []
  );
  if (undo.length === result.undo.length) return result;
  const failed = result.inputItemIds.length - undo.length;
  return {
    ...result,
    message: bulkAnswerMessage(undo.length, failed),
    answered: undo.length,
    answeredInputItemIds: undo.map((target) => target.inputItemId),
    failed,
    undo
  };
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
    // Only this code says the mutation may have committed. Any other failure
    // the server words itself is a refusal, whatever its status.
    throw new HumanMutationError(
      result.message,
      result,
      result.code === "temporary_unavailable"
    );
  }
  if (!response.ok) {
    // The status and the result contradict each other, which this server
    // never sends, so the outcome is not known.
    throw new HumanMutationError(
      "Action is temporarily unavailable.",
      null,
      true
    );
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
    return (
      inputItemIds.length === 1 &&
      isHumanUndoTarget(result.undo) &&
      result.undo.inputItemId === inputItemIds[0]
    );
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
