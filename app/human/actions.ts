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
import {
  resolveHumanAccountSession,
  runHumanAccountTransaction,
  type HumanAccountSession
} from "../../src/server/human-session";

const humanPath = "/human";

export async function submitHumanAnswer(formData: FormData) {
  const failedActionKind =
    formData.get("popupKind") === "file_upload" ? "file_upload" : undefined;
  const parsed = parseHumanAnswerForm(formData);
  if (!parsed.ok) {
    refreshHumanPage({
      error: "invalid_request",
      ...(failedActionKind ? { failedActionKind } : {})
    });
  }

  if (humanBrowserFixtureEnabled()) {
    refreshHumanPage({
      item: parsed.inputItemId,
      notice: "answer_submitted",
      action: parsed.actionValue
    });
  }

  const requestId = createCorrelationId("human_answer_req");
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
    refreshHumanPage({
      item: parsed.inputItemId,
      error: "temporary_unavailable",
      ...(failedActionKind ? { failedActionKind } : {})
    });
  }
  if (!transaction.ok) {
    refreshHumanPage({
      item: parsed.inputItemId,
      error: transaction.code,
      ...(failedActionKind ? { failedActionKind } : {})
    });
  }
  const result = transaction.data;

  refreshHumanPage(
    result.ok
      ? {
          item: parsed.inputItemId,
          notice: "answer_submitted",
          action: parsed.actionValue
        }
      : {
          item: parsed.inputItemId,
          error: result.code,
          ...(failedActionKind ? { failedActionKind } : {})
        }
  );
}

export async function submitBulkHumanAnswers(formData: FormData) {
  const parsed = parseBulkHumanAnswersForm(formData);
  if (!parsed.ok) {
    refreshHumanPage({ error: "invalid_request" });
  }

  if (humanBrowserFixtureEnabled()) {
    refreshHumanPage({
      notice: "bulk_answered",
      answered: String(parsed.items.length),
      failed: "0"
    });
  }

  const context = await humanActionContext();
  if (!context.ok) {
    refreshHumanPage({ error: context.code });
  }

  let answered = 0;
  let failed = 0;
  for (const item of parsed.items) {
    const result = await createHumanAnswer(context.connectionString, {
      accountId: context.accountId,
      callerId: item.callerId,
      humanUserId: context.userId,
      requestId: createCorrelationId("human_bulk_answer_req"),
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

  refreshHumanPage({
    notice: "bulk_answered",
    answered: String(answered),
    failed: String(failed)
  });
}

export async function undoHumanAnswer(formData: FormData) {
  const parsed = parseUndoHumanAnswerForm(formData);
  if (!parsed.ok) {
    refreshHumanPage({ error: "invalid_request" });
  }

  if (humanBrowserFixtureEnabled()) {
    refreshHumanPage({ item: parsed.inputItemId, notice: "answer_undone" });
  }

  const requestId = createCorrelationId("human_undo_req");
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
    refreshHumanPage({
      item: parsed.inputItemId,
      error: "temporary_unavailable"
    });
  }
  if (!transaction.ok) {
    refreshHumanPage({ item: parsed.inputItemId, error: transaction.code });
  }
  const result = transaction.data;

  refreshHumanPage(
    result.ok
      ? { item: parsed.inputItemId, notice: "answer_undone" }
      : { item: parsed.inputItemId, error: result.code }
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

function refreshHumanPage(params: Record<string, string>): never {
  revalidatePath(humanPath);
  const query = new URLSearchParams(params);
  redirect(`${humanPath}?${query.toString()}`);
}
