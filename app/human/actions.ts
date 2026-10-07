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
  undoHumanAnswerBeforeReadInTransaction,
  type CreateHumanAnswerInput,
  type HumanAnswerFailure,
  type PreReadUndoInput
} from "../../src/server/human-answer";
import {
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../../src/server/human-action-form";
import { humanBrowserFixtureEnabled } from "../../src/server/human-review-fixture";
import type { ProductTransactionQuery } from "../../src/server/database";
import { emitClientEventLog } from "../../src/server/client-events";
import {
  resolveHumanAccountSession,
  runHumanAccountTransaction,
  type HumanAccountSession
} from "../../src/server/human-session";
import { HUMAN_REVIEW_VIEW_PARAM_KEYS } from "../../src/shared/human-review-view";
import type {
  HumanAnswerMutationSuccess,
  HumanBulkMutationSuccess,
  HumanUndoMutationSuccess,
  HumanMutationFailure,
  HumanMutationResult
} from "../../src/shared/human-mutation";

const humanPath = "/human";

export async function executeHumanAnswerMutation(
  formData: FormData
): Promise<HumanMutationResult> {
  const requestId = createCorrelationId("human_answer_req");
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

  if (humanBrowserFixtureEnabled()) {
    const actionDisplay =
      noticeText(formData, "noticeAction") ?? parsed.actionValue;
    const { recordFixtureResolvedItems } =
      await import("../../src/server/human-review-fixture-state");
    await recordFixtureResolvedItems([
      {
        inputItemId: parsed.inputItemId,
        callerId: parsed.callerId,
        actionDisplay,
        currentRevision: parsed.expectedRevision
      }
    ]);
    revalidatePath(humanPath);
    return answerSuccess(
      parsed.inputItemId,
      parsed.callerId,
      "00000000-0000-4000-8000-000000009999"
    );
  }

  const result = await runHumanActionMutation({
    requestId,
    buildInput: (session): CreateHumanAnswerInput => ({
      accountId: session.accountId,
      callerId: parsed.callerId,
      humanUserId: session.userId,
      requestId,
      correlationId: createCorrelationId("human_answer"),
      inputItemId: parsed.inputItemId,
      expectedRevision: parsed.expectedRevision,
      actionValue: parsed.actionValue,
      response: parsed.response,
      feedback: parsed.feedback
    }),
    run: createHumanAnswerInTransaction,
    reportFailure: humanAnswerTransactionFailure
  });

  if (result.ok) {
    revalidatePath(humanPath);
    return answerSuccess(
      result.inputItemId,
      parsed.callerId,
      result.outputResultId
    );
  }
  return humanMutationFailure(
    "answer",
    [parsed.inputItemId],
    result.code,
    result.message,
    requestId,
    failedActionKind
  );
}

export async function executeBulkHumanAnswersMutation(
  formData: FormData
): Promise<HumanMutationResult> {
  const requestId = createCorrelationId("human_bulk_answer_req");
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

  if (humanBrowserFixtureEnabled()) {
    const { recordFixtureResolvedItems } =
      await import("../../src/server/human-review-fixture-state");
    await recordFixtureResolvedItems(
      parsed.items.map((item) => ({
        inputItemId: item.inputItemId,
        callerId: item.callerId,
        currentRevision: item.expectedRevision,
        actionDisplay:
          noticeText(formData, "noticeAction") ?? parsed.actionValue
      }))
    );
    revalidatePath(humanPath);
    return bulkSuccess(inputItemIds, inputItemIds, 0);
  }

  const context = await humanActionContext();
  if (!context.ok) {
    return humanMutationFailure(
      "bulk-answer",
      inputItemIds,
      context.code,
      context.message,
      requestId
    );
  }

  const answeredInputItemIds: string[] = [];
  let failed = 0;
  for (const item of parsed.items) {
    const result = await createHumanAnswer(context.connectionString, {
      accountId: context.accountId,
      callerId: item.callerId,
      humanUserId: context.userId,
      requestId,
      correlationId: createCorrelationId("human_bulk_answer"),
      inputItemId: item.inputItemId,
      expectedRevision: item.expectedRevision,
      actionValue: parsed.actionValue,
      response: { kind: "none" },
      feedback: item.feedback
    });
    if (result.ok) {
      answeredInputItemIds.push(item.inputItemId);
    } else {
      failed += 1;
    }
  }

  const answered = answeredInputItemIds.length;
  if (answered === 0 && failed > 0) {
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
  return bulkSuccess(inputItemIds, answeredInputItemIds, failed);
}

export async function executeUndoHumanAnswerMutation(
  formData: FormData
): Promise<HumanMutationResult> {
  const requestId = createCorrelationId("human_undo_req");
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

  if (humanBrowserFixtureEnabled()) {
    const { restoreFixtureResolvedItem } =
      await import("../../src/server/human-review-fixture-state");
    await restoreFixtureResolvedItem(parsed.inputItemId);
    revalidatePath(humanPath);
    return undoSuccess(parsed.inputItemId);
  }

  const result = await runHumanActionMutation({
    requestId,
    buildInput: (session): PreReadUndoInput => ({
      accountId: session.accountId,
      callerId: parsed.callerId,
      humanUserId: session.userId,
      requestId,
      correlationId: createCorrelationId("human_undo"),
      outputResultId: parsed.outputResultId
    }),
    run: undoHumanAnswerBeforeReadInTransaction,
    reportFailure: humanAnswerUndoTransactionFailure
  });

  if (result.ok) {
    revalidatePath(humanPath);
    return undoSuccess(parsed.inputItemId);
  }
  return humanMutationFailure(
    "undo",
    [parsed.inputItemId],
    result.code,
    result.message,
    requestId
  );
}

export async function submitHumanAnswer(formData: FormData) {
  redirectHumanMutationResult(
    formData,
    await executeHumanAnswerMutation(formData)
  );
}

export async function submitBulkHumanAnswers(formData: FormData) {
  redirectHumanMutationResult(
    formData,
    await executeBulkHumanAnswersMutation(formData)
  );
}

export async function undoHumanAnswer(formData: FormData) {
  redirectHumanMutationResult(
    formData,
    await executeUndoHumanAnswerMutation(formData)
  );
}

async function humanActionContext() {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return {
      ok: false as const,
      code: "missing_database_configuration",
      message: "Human actions are not configured."
    };
  }

  const session = await auth.protect({ unauthenticatedUrl: "/sign-in" });
  const humanSession = await resolveHumanAccountSession({
    clerkUserId: session.userId,
    requestId: createCorrelationId("human_action_session_req"),
    route: "/human",
    method: "POST"
  });
  if (!humanSession.ok) {
    return {
      ok: false as const,
      code: humanSession.code,
      message: humanSession.message
    };
  }

  return {
    ok: true as const,
    connectionString,
    accountId: humanSession.accountId,
    userId: humanSession.userId
  };
}

async function runHumanActionMutation<TInput, TSuccess extends { ok: true }>({
  requestId,
  buildInput,
  run,
  reportFailure
}: {
  requestId: string;
  buildInput: (session: HumanAccountSession) => TInput;
  run: (
    query: ProductTransactionQuery,
    input: TInput
  ) => Promise<TSuccess | HumanAnswerFailure>;
  reportFailure: (error: unknown, input: TInput) => HumanAnswerFailure;
}): Promise<TSuccess | Pick<HumanMutationFailure, "ok" | "code" | "message">> {
  const clerkSession = await auth.protect({ unauthenticatedUrl: "/sign-in" });
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
        input = buildInput(accountSession);
        return run(query, input);
      }
    );
    return transaction.ok
      ? transaction.data
      : { ok: false, code: transaction.code, message: transaction.message };
  } catch (error) {
    if (input === null) {
      throw error;
    }
    return reportFailure(error, input);
  }
}

function answerSuccess(
  inputItemId: string,
  callerId: string,
  outputResultId: string
): HumanAnswerMutationSuccess {
  return {
    ok: true,
    operation: "answer",
    message: "Done.",
    inputItemIds: [inputItemId],
    undo: { inputItemId, callerId, outputResultId }
  };
}

function undoSuccess(inputItemId: string): HumanUndoMutationSuccess {
  return {
    ok: true,
    operation: "undo",
    message: "Undone.",
    inputItemIds: [inputItemId]
  };
}

function bulkSuccess(
  inputItemIds: string[],
  answeredInputItemIds: string[],
  failed: number
): HumanBulkMutationSuccess {
  const answered = answeredInputItemIds.length;
  return {
    ok: true,
    operation: "bulk-answer",
    message: `Bulk action complete: ${answered} answered, ${failed} failed.`,
    inputItemIds,
    answered,
    answeredInputItemIds,
    failed
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

function redirectHumanMutationResult(
  formData: FormData,
  result: HumanMutationResult
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
