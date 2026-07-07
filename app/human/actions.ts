"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createCorrelationId } from "../../src/server/correlation";
import {
  createHumanAnswer,
  undoHumanAnswerBeforeRead
} from "../../src/server/human-answer";
import {
  parseBulkHumanAnswersForm,
  parseHumanAnswerForm,
  parseUndoHumanAnswerForm
} from "../../src/server/human-action-form";
import { humanBrowserFixtureEnabled } from "../../src/server/human-review-fixture";
import { resolveHumanAccountSession } from "../../src/server/human-session";

const humanPath = "/human";

export async function submitHumanAnswer(formData: FormData) {
  const parsed = parseHumanAnswerForm(formData);
  if (!parsed.ok) {
    refreshHumanPage({ error: "invalid_request" });
  }

  if (humanBrowserFixtureEnabled()) {
    refreshHumanPage({
      item: parsed.inputItemId,
      notice: "answer_submitted",
      action: parsed.actionValue
    });
  }

  const context = await humanActionContext();
  if (!context.ok) {
    refreshHumanPage({
      item: parsed.inputItemId,
      error: context.code
    });
  }

  const result = await createHumanAnswer(context.connectionString, {
    accountId: context.accountId,
    callerId: parsed.callerId,
    humanUserId: context.userId,
    requestId: createCorrelationId("human_answer_req"),
    correlationId: createCorrelationId("human_answer"),
    inputItemId: parsed.inputItemId,
    expectedRevision: parsed.expectedRevision,
    actionValue: parsed.actionValue,
    response: parsed.response
  });

  refreshHumanPage(
    result.ok
      ? {
          item: parsed.inputItemId,
          notice: "answer_submitted",
          action: parsed.actionValue
        }
      : { item: parsed.inputItemId, error: result.code }
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

  const context = await humanActionContext();
  if (!context.ok) {
    refreshHumanPage({ item: parsed.inputItemId, error: context.code });
  }

  const result = await undoHumanAnswerBeforeRead(context.connectionString, {
    accountId: context.accountId,
    callerId: parsed.callerId,
    humanUserId: context.userId,
    requestId: createCorrelationId("human_undo_req"),
    correlationId: createCorrelationId("human_undo"),
    outputResultId: parsed.outputResultId
  });

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

function refreshHumanPage(params: Record<string, string>): never {
  revalidatePath(humanPath);
  const query = new URLSearchParams(params);
  redirect(`${humanPath}?${query.toString()}`);
}
