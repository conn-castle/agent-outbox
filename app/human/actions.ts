"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createCorrelationId } from "../../src/server/correlation";
import {
  createHumanAnswer,
  createHumanAnswerInTransaction,
  humanAnswerTransactionFailure,
  humanAnswerUndoTransactionFailure,
  undoHumanAnswerBeforeRead,
  undoHumanAnswerBeforeReadInTransaction,
  type CreateHumanAnswerInput,
  type HumanActionResponse,
  type HumanAnswerFailure,
  type PreReadUndoInput
} from "../../src/server/human-answer";
import {
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../../src/server/human-action-form";
import {
  fixtureResolvedOutputResultId,
  humanBrowserFixtureEnabled
} from "../../src/server/human-review-fixture";
import type { ProductTransactionQuery } from "../../src/server/database";
import { emitClientEventLog } from "../../src/server/client-events";
import { loadHumanReviewItemStates } from "../../src/server/human-review-page";
import {
  runHumanAccountTransaction,
  type HumanAccountSession
} from "../../src/server/human-session";
import { HUMAN_REVIEW_VIEW_PARAM_KEYS } from "../../src/shared/human-review-view";
import type {
  HumanAnswerMutationSuccess,
  HumanBulkMutationSuccess,
  HumanUndoMutationSuccess,
  HumanUndoTarget,
  HumanMutationFailure,
  HumanMutationResult,
  HumanMutationState
} from "../../src/shared/human-mutation";

const humanPath = "/human";
// A failure whose mutation may have committed; the route answers it with 503.
const TEMPORARY_UNAVAILABLE = "temporary_unavailable";

// A mutation outcome before the items' authoritative state is attached.
type MutationOutcome =
  | HumanMutationFailure
  | Omit<HumanAnswerMutationSuccess, "state">
  | Omit<HumanBulkMutationSuccess, "state">
  | Omit<HumanUndoMutationSuccess, "state">;

type BackendFailure = {
  ok: false;
  code: string;
  message: string;
  // The request has no usable session, so no item of it can succeed.
  sessionFailed?: true;
};

type AnswerItem = {
  inputItemId: string;
  callerId: string;
  expectedRevision: number;
  actionValue: string;
  actionDisplay: string;
  response: HumanActionResponse;
  feedback?: string;
  mutationId: string;
  correlationId: string;
};

/**
 * Where a request's mutations are applied: the database, or the browser
 * fixture's cookie state. Each answer and undo commits on its own, so one
 * rejected item cannot block the rest of a bulk request.
 */
type MutationBackend = {
  answer(
    item: AnswerItem
  ): Promise<{ ok: true; outputResultId: string } | BackendFailure>;
  undo(
    target: HumanUndoTarget,
    correlationId: string
  ): Promise<{ ok: true } | BackendFailure>;
  /** Current rows read after the mutations committed; null without a session. */
  itemStates(inputItemIds: string[]): Promise<HumanMutationState | null>;
};

export async function executeHumanAnswerMutation(
  formData: FormData
): Promise<HumanMutationResult> {
  const backend = await mutationBackend(
    createCorrelationId("human_answer_req")
  );
  return withItemStates(await answerOutcome(formData, backend), backend);
}

export async function executeBulkHumanAnswersMutation(
  formData: FormData
): Promise<HumanMutationResult> {
  const backend = await mutationBackend(
    createCorrelationId("human_bulk_answer_req")
  );
  return withItemStates(
    await bulkAnswerOutcome(formData, backend, true),
    backend
  );
}

export async function executeUndoHumanAnswerMutation(
  formData: FormData
): Promise<HumanMutationResult> {
  const backend = await mutationBackend(createCorrelationId("human_undo_req"));
  return withItemStates(await undoOutcome(formData, backend, true), backend);
}

// The redirecting form actions report through the URL, not item state, and
// a submitted form is not repeated under its mutation id.
export async function submitHumanAnswer(formData: FormData) {
  redirectHumanMutationOutcome(
    formData,
    await answerOutcome(
      formData,
      await mutationBackend(createCorrelationId("human_answer_req"))
    )
  );
}

export async function submitBulkHumanAnswers(formData: FormData) {
  redirectHumanMutationOutcome(
    formData,
    await bulkAnswerOutcome(
      formData,
      await mutationBackend(createCorrelationId("human_bulk_answer_req")),
      false
    )
  );
}

export async function undoHumanAnswer(formData: FormData) {
  redirectHumanMutationOutcome(
    formData,
    await undoOutcome(
      formData,
      await mutationBackend(createCorrelationId("human_undo_req")),
      false
    )
  );
}

async function answerOutcome(
  formData: FormData,
  backend: MutationBackend & { requestId: string }
): Promise<MutationOutcome> {
  const { requestId } = backend;
  const failedActionKind =
    formData.get("popupKind") === "file_upload" ? "file_upload" : undefined;
  const parsed = parseHumanAnswerForm(formData);
  if (!parsed.ok) {
    return humanMutationFailure(
      "answer",
      [],
      "invalid_request",
      "Action failed: invalid request.",
      requestId,
      failedActionKind
    );
  }

  const result = await backend.answer({
    inputItemId: parsed.inputItemId,
    callerId: parsed.callerId,
    expectedRevision: parsed.expectedRevision,
    actionValue: parsed.actionValue,
    actionDisplay: noticeText(formData, "noticeAction") ?? parsed.actionValue,
    response: parsed.response,
    feedback: parsed.feedback,
    mutationId: parsed.mutationId,
    correlationId: `human_answer_${parsed.mutationId}`
  });
  if (!result.ok) {
    return humanMutationFailure(
      "answer",
      [parsed.inputItemId],
      result.code,
      result.message,
      requestId,
      failedActionKind
    );
  }
  revalidatePath(humanPath);
  return {
    ok: true,
    operation: "answer",
    message: "Done.",
    inputItemIds: [parsed.inputItemId],
    undo: {
      inputItemId: parsed.inputItemId,
      callerId: parsed.callerId,
      outputResultId: result.outputResultId
    }
  };
}

/**
 * Answers each item in turn. `retryable` says the caller can repeat the
 * request under the same mutation id: a temporary failure, which leaves that
 * item's outcome unknown, then stops the request so that its repeat replays
 * what committed and tries the rest. A caller that cannot repeat it gets the
 * remaining items tried and the failure counted.
 */
async function bulkAnswerOutcome(
  formData: FormData,
  backend: MutationBackend & { requestId: string },
  retryable: boolean
): Promise<MutationOutcome> {
  const { requestId } = backend;
  const parsed = parseBulkHumanAnswersForm(formData);
  if (!parsed.ok) {
    return humanMutationFailure(
      "bulk-answer",
      [],
      "invalid_request",
      "Bulk action failed: invalid request.",
      requestId
    );
  }
  const inputItemIds = parsed.items.map((item) => item.inputItemId);
  const actionDisplay =
    noticeText(formData, "noticeAction") ?? parsed.actionValue;

  const undo: HumanUndoTarget[] = [];
  for (const item of parsed.items) {
    const result = await backend.answer({
      inputItemId: item.inputItemId,
      callerId: item.callerId,
      expectedRevision: item.expectedRevision,
      actionValue: parsed.actionValue,
      actionDisplay,
      response: { kind: "none" },
      feedback: item.feedback,
      mutationId: parsed.mutationId,
      correlationId: `human_bulk_answer_${parsed.mutationId}`
    });
    if (result.ok) {
      undo.push({
        inputItemId: item.inputItemId,
        callerId: item.callerId,
        outputResultId: result.outputResultId
      });
    } else if (
      result.sessionFailed ||
      (retryable && result.code === TEMPORARY_UNAVAILABLE)
    ) {
      // Without a session nothing more can succeed. The answers committed so
      // far are reported with the failure, in case no repeat gets further.
      const failure = humanMutationFailure(
        "bulk-answer",
        inputItemIds,
        result.code,
        result.message,
        requestId
      );
      if (undo.length === 0) return failure;
      revalidatePath(humanPath);
      return { ...failure, undo };
    }
  }

  const answered = undo.length;
  const failed = inputItemIds.length - answered;
  if (answered === 0) {
    return humanMutationFailure(
      "bulk-answer",
      inputItemIds,
      "bulk_answer_failed",
      `Bulk action failed: ${failed} not answered.`,
      requestId
    );
  }
  if (failed > 0) {
    emitHumanActionFailure(requestId);
  }
  revalidatePath(humanPath);
  return {
    ok: true,
    operation: "bulk-answer",
    message: `Bulk action complete: ${answered} answered, ${failed} failed.`,
    inputItemIds,
    answered,
    answeredInputItemIds: undo.map((target) => target.inputItemId),
    failed,
    undo
  };
}

/** Undoes each target in turn; `retryable` is as for a bulk answer. */
async function undoOutcome(
  formData: FormData,
  backend: MutationBackend & { requestId: string },
  retryable: boolean
): Promise<MutationOutcome> {
  const { requestId } = backend;
  const parsed = parseUndoHumanAnswerForm(formData);
  if (!parsed.ok) {
    return humanMutationFailure(
      "undo",
      [],
      "invalid_request",
      "Undo failed: invalid request.",
      requestId
    );
  }
  const inputItemIds = parsed.targets.map((target) => target.inputItemId);

  const restoredInputItemIds: string[] = [];
  const failures: BackendFailure[] = [];
  for (const target of parsed.targets) {
    const result = await backend.undo(
      target,
      `human_undo_${parsed.mutationId}`
    );
    if (result.ok) {
      restoredInputItemIds.push(target.inputItemId);
    } else if (
      result.sessionFailed ||
      (retryable && result.code === TEMPORARY_UNAVAILABLE)
    ) {
      // The failure's item state tells the client which answers were restored.
      if (restoredInputItemIds.length > 0) revalidatePath(humanPath);
      return humanMutationFailure(
        "undo",
        inputItemIds,
        result.code,
        result.message,
        requestId
      );
    } else {
      failures.push(result);
    }
  }

  const failed = inputItemIds.length - restoredInputItemIds.length;
  if (restoredInputItemIds.length === 0) {
    // A shared code lets the client tell a permanent rejection from a
    // retryable one; mixed causes are reported as retryable.
    const [first] = failures;
    const sharedCode =
      first && failures.every((failure) => failure.code === first.code)
        ? first.code
        : "undo_failed";
    return humanMutationFailure(
      "undo",
      inputItemIds,
      sharedCode,
      first && inputItemIds.length === 1
        ? first.message
        : `Undo failed: ${failed} not restored.`,
      requestId
    );
  }
  if (failed > 0) {
    emitHumanActionFailure(requestId);
  }
  revalidatePath(humanPath);
  return {
    ok: true,
    operation: "undo",
    message:
      failed > 0
        ? `Undo complete: ${restoredInputItemIds.length} restored, ${failed} failed.`
        : "Undone.",
    inputItemIds,
    restoredInputItemIds,
    failed
  };
}

/**
 * Attaches the items' authoritative rows. A success without them cannot be
 * applied by the client, so that read failing fails the request; the client
 * repeats it, and the repeat reports the mutation that already committed.
 */
async function withItemStates(
  outcome: MutationOutcome,
  backend: MutationBackend
): Promise<HumanMutationResult> {
  if (outcome.ok) {
    const state = await backend.itemStates(outcome.inputItemIds);
    if (!state) {
      throw new Error("Human mutation succeeded without a session.");
    }
    return { ...outcome, state };
  }
  if (outcome.inputItemIds.length === 0) return outcome;
  try {
    const state = await backend.itemStates(outcome.inputItemIds);
    return state ? { ...outcome, state } : outcome;
  } catch {
    // The failure itself is the answer; its item state is a refinement.
    return outcome;
  }
}

async function mutationBackend(
  requestId: string
): Promise<MutationBackend & { requestId: string }> {
  return {
    requestId,
    ...(humanBrowserFixtureEnabled()
      ? await fixtureMutationBackend()
      : databaseMutationBackend(requestId))
  };
}

async function fixtureMutationBackend(): Promise<MutationBackend> {
  const fixture = await import("../../src/server/human-review-fixture-state");
  return {
    async answer(item) {
      const result = await fixture.answerFixtureItem({
        inputItemId: item.inputItemId,
        callerId: item.callerId,
        actionDisplay: item.actionDisplay,
        expectedRevision: item.expectedRevision,
        mutationId: item.mutationId
      });
      return result.ok
        ? {
            ok: true,
            outputResultId: fixtureResolvedOutputResultId(
              item.inputItemId,
              item.expectedRevision
            )
          }
        : result;
    },
    undo: (target) => fixture.undoFixtureAnswer(target),
    itemStates: fixture.readFixtureItemStates
  };
}

function databaseMutationBackend(requestId: string): MutationBackend {
  let session: HumanAccountSession | null = null;
  let sessionFailure: BackendFailure | null = null;

  // The request's first mutation shares the transaction that resolves the
  // session; later ones reuse that session in transactions of their own.
  async function mutate<TInput, TSuccess extends { ok: true }>(
    buildInput: (session: HumanAccountSession) => TInput,
    inTransaction: (
      query: ProductTransactionQuery,
      input: TInput
    ) => Promise<TSuccess | HumanAnswerFailure>,
    standalone: (
      connectionString: string,
      input: TInput
    ) => Promise<TSuccess | HumanAnswerFailure>,
    reportFailure: (
      error: unknown,
      input: TInput,
      startedAtMs: number
    ) => HumanAnswerFailure
  ): Promise<TSuccess | BackendFailure> {
    if (sessionFailure) return sessionFailure;
    if (session) {
      const connectionString = process.env.DATABASE_APP_ROLE_URL;
      if (!connectionString) {
        throw new Error("Human account database configuration is unavailable.");
      }
      return standalone(connectionString, buildInput(session));
    }
    const clerkSession = await auth.protect({
      unauthenticatedUrl: "/sign-in"
    });
    const startedAtMs = Date.now();
    let input: TInput | null = null;
    try {
      const transaction = await runHumanAccountTransaction(
        {
          clerkUserId: clerkSession.userId,
          requestId,
          route: "/human",
          method: "POST"
        },
        (query, accountSession) => {
          session = accountSession;
          input = buildInput(accountSession);
          return inTransaction(query, input);
        }
      );
      if (transaction.ok) return transaction.data;
      sessionFailure = {
        ok: false,
        code: transaction.code,
        message: transaction.message,
        sessionFailed: true
      };
      return sessionFailure;
    } catch (error) {
      if (input === null) {
        throw error;
      }
      return reportFailure(error, input, startedAtMs);
    }
  }

  return {
    answer: (item) =>
      mutate(
        (accountSession): CreateHumanAnswerInput => ({
          accountId: accountSession.accountId,
          callerId: item.callerId,
          humanUserId: accountSession.userId,
          requestId,
          correlationId: item.correlationId,
          inputItemId: item.inputItemId,
          expectedRevision: item.expectedRevision,
          actionValue: item.actionValue,
          response: item.response,
          feedback: item.feedback
        }),
        createHumanAnswerInTransaction,
        createHumanAnswer,
        humanAnswerTransactionFailure
      ),
    undo: (target, correlationId) =>
      mutate(
        (accountSession): PreReadUndoInput => ({
          accountId: accountSession.accountId,
          callerId: target.callerId,
          humanUserId: accountSession.userId,
          requestId,
          correlationId,
          inputItemId: target.inputItemId,
          outputResultId: target.outputResultId
        }),
        undoHumanAnswerBeforeReadInTransaction,
        undoHumanAnswerBeforeRead,
        humanAnswerUndoTransactionFailure
      ),
    itemStates: async (inputItemIds) =>
      session
        ? loadHumanReviewItemStates(session, requestId, inputItemIds)
        : null
  };
}

function returnsToQueue(formData: FormData) {
  return formData.get("returnToQueue") === "1";
}

function noticeText(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 160) : null;
}

/**
 * View state (search/status/primary sort/secondary sort/page) submitted as
 * hidden `view.*` fields by
 * `ViewStateFields` so post-action redirects restore the user's current view.
 * Values are re-validated server-side by `humanReviewView` on the next render.
 */
function viewParamsFromForm(formData: FormData) {
  const params = new URLSearchParams();
  for (const key of HUMAN_REVIEW_VIEW_PARAM_KEYS) {
    for (const value of formData.getAll(`view.${key}`)) {
      if (typeof value === "string" && value !== "") params.append(key, value);
    }
  }
  return params;
}

function refreshHumanPage(
  formData: FormData,
  params: Record<string, string>
): never {
  revalidatePath(humanPath);
  const query = viewParamsFromForm(formData);
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  redirect(`${humanPath}?${query.toString()}`);
}

function humanMutationFailure(
  operation: HumanMutationFailure["operation"],
  inputItemIds: string[],
  code: string,
  message: string,
  requestId: string,
  kind?: "file_upload"
): HumanMutationFailure {
  emitHumanActionFailure(requestId, kind);
  return {
    ok: false,
    operation,
    code,
    message,
    inputItemIds,
    ...(kind ? { failedActionKind: kind } : {})
  };
}

function redirectHumanMutationOutcome(
  formData: FormData,
  result: MutationOutcome
): never {
  const subject = noticeText(formData, "noticeSubject");
  const action = noticeText(formData, "noticeAction");
  if (!result.ok) {
    refreshHumanPage(formData, {
      ...(result.inputItemIds[0] ? { item: result.inputItemIds[0] } : {}),
      error: result.code,
      ...(subject ? { subject } : {}),
      ...(result.failedActionKind
        ? { failedActionKind: result.failedActionKind }
        : {})
    });
  }

  switch (result.operation) {
    case "answer":
      refreshHumanPage(formData, {
        ...(returnsToQueue(formData) ? {} : { item: result.inputItemIds[0] }),
        notice: "answer_submitted",
        resolved: result.inputItemIds[0],
        undo_target: result.undo.inputItemId,
        undo_actor: result.undo.callerId,
        undo_result: result.undo.outputResultId,
        ...(subject ? { subject } : {}),
        ...(action ? { action } : {})
      });
    case "bulk-answer":
      refreshHumanPage(formData, {
        notice: "bulk_answered",
        answered: String(result.answered),
        failed: String(result.failed)
      });
    case "undo":
      refreshHumanPage(formData, {
        item: result.inputItemIds[0],
        notice: "answer_undone",
        ...(subject ? { subject } : {})
      });
  }
}

function emitHumanActionFailure(requestId: string, kind?: "file_upload") {
  emitClientEventLog(
    kind === "file_upload"
      ? { name: "file_upload_failed" }
      : { name: "human_action_failed" },
    { requestId, route: humanPath, producer: "server_action" }
  );
}
