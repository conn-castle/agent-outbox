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

const humanPath = "/human";

export async function submitHumanAnswer(formData: FormData) {
  const requestId = createCorrelationId("human_answer_req");
  const failedActionKind =
    formData.get("popupKind") === "file_upload" ? "file_upload" : undefined;
  const parsed = parseHumanAnswerForm(formData);
  if (!parsed.ok) {
    refreshHumanFailurePage(
      formData,
      {
        error: "invalid_request",
        ...(failedActionKind ? { failedActionKind } : {})
      },
      requestId,
      failedActionKind
    );
  }

  if (humanBrowserFixtureEnabled()) {
    refreshHumanPage(formData, {
      item: parsed.inputItemId,
      notice: "answer_submitted",
      action: parsed.actionValue
    });
  }

  let answerInput: CreateHumanAnswerInput | null = null;
  let transaction;
  try {
    transaction = await runHumanActionTransaction(
      requestId,
      (query, session) => {
        answerInput = {
          accountId: session.accountId,
          callerId: parsed.callerId,
          humanUserId: session.userId,
          requestId,
          correlationId: createCorrelationId("human_answer"),
          inputItemId: parsed.inputItemId,
          expectedRevision: parsed.expectedRevision,
          actionValue: parsed.actionValue,
          response: parsed.response
        };
        return createHumanAnswerInTransaction(query, answerInput);
      }
    );
  } catch (error) {
    if (!answerInput) {
      throw error;
    }
    humanAnswerTransactionFailure(error, answerInput);
    refreshHumanFailurePage(
      formData,
      {
        item: parsed.inputItemId,
        error: "temporary_unavailable",
        ...(failedActionKind ? { failedActionKind } : {})
      },
      requestId,
      failedActionKind
    );
  }
  if (!transaction.ok) {
    refreshHumanFailurePage(
      formData,
      {
        item: parsed.inputItemId,
        error: transaction.code,
        ...(failedActionKind ? { failedActionKind } : {})
      },
      requestId,
      failedActionKind
    );
  }
  const result = transaction.data;

  if (result.ok) {
    refreshHumanPage(formData, {
      item: parsed.inputItemId,
      notice: "answer_submitted",
      action: parsed.actionValue
    });
  }
  refreshHumanFailurePage(
    formData,
    {
      item: parsed.inputItemId,
      error: result.code,
      ...(failedActionKind ? { failedActionKind } : {})
    },
    requestId,
    failedActionKind
  );
}

export async function submitBulkHumanAnswers(formData: FormData) {
  const requestId = createCorrelationId("human_bulk_answer_req");
  const parsed = parseBulkHumanAnswersForm(formData);
  if (!parsed.ok) {
    refreshHumanFailurePage(formData, { error: "invalid_request" }, requestId);
  }

  if (humanBrowserFixtureEnabled()) {
    refreshHumanPage(formData, {
      notice: "bulk_answered",
      answered: String(parsed.items.length),
      failed: "0"
    });
  }

  const context = await humanActionContext();
  if (!context.ok) {
    refreshHumanFailurePage(formData, { error: context.code }, requestId);
  }

  let answered = 0;
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
      response: { kind: "none" }
    });
    if (result.ok) {
      answered += 1;
    } else {
      failed += 1;
    }
  }

  if (failed > 0) {
    emitHumanActionFailure(requestId);
  }
  refreshHumanPage(formData, {
    notice: "bulk_answered",
    answered: String(answered),
    failed: String(failed)
  });
}

export async function undoHumanAnswer(formData: FormData) {
  const requestId = createCorrelationId("human_undo_req");
  const parsed = parseUndoHumanAnswerForm(formData);
  if (!parsed.ok) {
    refreshHumanFailurePage(formData, { error: "invalid_request" }, requestId);
  }

  if (humanBrowserFixtureEnabled()) {
    refreshHumanPage(formData, {
      item: parsed.inputItemId,
      notice: "answer_undone"
    });
  }

  let undoInput: PreReadUndoInput | null = null;
  let transaction;
  try {
    transaction = await runHumanActionTransaction(
      requestId,
      (query, session) => {
        undoInput = {
          accountId: session.accountId,
          callerId: parsed.callerId,
          humanUserId: session.userId,
          requestId,
          correlationId: createCorrelationId("human_undo"),
          outputResultId: parsed.outputResultId
        };
        return undoHumanAnswerBeforeReadInTransaction(query, undoInput);
      }
    );
  } catch (error) {
    if (!undoInput) {
      throw error;
    }
    humanAnswerUndoTransactionFailure(error, undoInput);
    refreshHumanFailurePage(
      formData,
      {
        item: parsed.inputItemId,
        error: "temporary_unavailable"
      },
      requestId
    );
  }
  if (!transaction.ok) {
    refreshHumanFailurePage(
      formData,
      { item: parsed.inputItemId, error: transaction.code },
      requestId
    );
  }
  const result = transaction.data;

  if (result.ok) {
    refreshHumanPage(formData, {
      item: parsed.inputItemId,
      notice: "answer_undone"
    });
  }
  refreshHumanFailurePage(
    formData,
    { item: parsed.inputItemId, error: result.code },
    requestId
  );
}

async function humanActionContext() {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return { ok: false as const, code: "missing_database_configuration" };
  }

  const session = await auth.protect({ unauthenticatedUrl: "/sign-in" });
  const humanSession = await resolveHumanAccountSession({
    clerkUserId: session.userId,
    requestId: createCorrelationId("human_action_session_req"),
    route: "/human",
    method: "POST"
  });
  if (!humanSession.ok) {
    return { ok: false as const, code: humanSession.code };
  }

  return {
    ok: true as const,
    connectionString,
    accountId: humanSession.accountId,
    userId: humanSession.userId
  };
}

async function runHumanActionTransaction<TResult>(
  requestId: string,
  callback: (
    query: ProductTransactionQuery,
    session: HumanAccountSession
  ) => Promise<TResult>
) {
  const session = await auth.protect({ unauthenticatedUrl: "/sign-in" });
  return runHumanAccountTransaction(
    {
      clerkUserId: session.userId,
      requestId,
      route: "/human",
      method: "POST"
    },
    callback
  );
}

const HUMAN_VIEW_PARAM_KEYS = ["search", "status", "sort", "page"] as const;

/**
 * View state (search/status/sort/page) submitted as hidden `view.*` fields by
 * `ViewStateFields` so post-action redirects restore the user's current view.
 * Values are re-validated server-side by `humanReviewView` on the next render.
 */
function viewParamsFromForm(formData: FormData): Record<string, string> {
  const params: Record<string, string> = {};
  for (const key of HUMAN_VIEW_PARAM_KEYS) {
    const value = formData.get(`view.${key}`);
    if (typeof value === "string" && value !== "") {
      params[key] = value;
    }
  }
  return params;
}

function refreshHumanPage(
  formData: FormData,
  params: Record<string, string>
): never {
  revalidatePath(humanPath);
  const query = new URLSearchParams({
    ...viewParamsFromForm(formData),
    ...params
  });
  redirect(`${humanPath}?${query.toString()}`);
}

function refreshHumanFailurePage(
  formData: FormData,
  params: Record<string, string>,
  requestId: string,
  kind?: "file_upload"
): never {
  emitHumanActionFailure(requestId, kind);
  refreshHumanPage(formData, params);
}

function emitHumanActionFailure(requestId: string, kind?: "file_upload") {
  emitClientEventLog(
    kind === "file_upload"
      ? { name: "file_upload_failed", category: "upload" }
      : { name: "human_action_failed", category: "submission" },
    { requestId, route: humanPath, producer: "server_action" }
  );
}
