import { auth } from "@clerk/nextjs/server";

import {
  type HumanReviewNotice,
  ReviewWorkspace
} from "../../src/components/human/ReviewWorkspace";
import { createCorrelationId } from "../../src/server/correlation";
import type { ProductTransactionQuery } from "../../src/server/database";
import {
  browserFixtureAccountBanner,
  browserFixtureHumanSession,
  browserFixtureReviewDetail,
  browserFixtureReviewPage,
  humanBrowserFixtureEnabled
} from "../../src/server/human-review-fixture";
import {
  humanReviewAccountBannerInTransaction,
  humanReviewDetailInTransaction,
  humanReviewPageInTransaction,
  REVIEW_PAGE_SIZE
} from "../../src/server/human-review";
import {
  type HumanAccountSession,
  requiredHumanSessionConfiguration,
  runHumanAccountTransaction
} from "../../src/server/human-session";
import { MissingConfigurationPanel } from "../../src/server/ui";
import {
  firstSearchParam,
  humanReviewViewFromRecord,
  type HumanReviewView
} from "../../src/shared/human-review-view";

export const dynamic = "force-dynamic";

export default async function HumanReviewPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const renderedAt = new Date().toISOString();
  const selectedItem = firstSearchParam(params?.item);
  const notice = humanReviewNotice(params);
  const view = humanReviewViewFromRecord(params);

  if (humanBrowserFixtureEnabled()) {
    const fixtureOptions = {
      includePaginationRows:
        firstSearchParam(params?.fixture_dataset) === "pagination",
      resolvedItemId: firstSearchParam(params?.resolved)
    };
    const session = browserFixtureHumanSession({
      firstTimeSignup: firstSearchParam(params?.fixture_signup) === "1",
      providerSubject: firstSearchParam(params?.fixture_provider_subject)
    });
    const fixturePage = browserFixtureReviewPage(view, fixtureOptions);
    return (
      <ReviewWorkspace
        key={session.accountId}
        session={session}
        rows={fixturePage.rows}
        detail={
          selectedItem
            ? browserFixtureReviewDetail(selectedItem, fixtureOptions)
            : null
        }
        banner={browserFixtureAccountBanner(session)}
        notice={notice}
        view={view}
        hasNext={fixturePage.hasNext}
        detailOpen={selectedItem !== undefined}
        renderedAt={renderedAt}
      />
    );
  }

  const missing = requiredHumanSessionConfiguration();
  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title="Human review route is not configured"
        missing={missing}
      />
    );
  }

  const session = await auth.protect({ unauthenticatedUrl: "/sign-in" });
  const transaction = await runHumanAccountTransaction(
    {
      clerkUserId: session.userId,
      requestId: createCorrelationId("human_req"),
      route: "/human",
      method: "GET"
    },
    (query, humanSession) =>
      loadHumanReviewPageDataInTransaction(
        query,
        humanSession,
        selectedItem ?? null,
        view
      )
  );

  if (!transaction.ok) {
    return (
      <main className="main">
        <p className="eyebrow">Protected human route</p>
        <h1 className="title">Review queue shell</h1>
        <section className="panel">
          <h2>Account context unavailable</h2>
          <ul className="status-list">
            <li>
              <span>Status</span>
              <code>{transaction.status}</code>
            </li>
            <li>
              <span>Code</span>
              <code>{transaction.code}</code>
            </li>
          </ul>
        </section>
      </main>
    );
  }

  const humanSession = transaction.session;
  const pageData = transaction.data;

  return (
    <ReviewWorkspace
      key={humanSession.accountId}
      session={humanSession}
      rows={pageData.rows}
      detail={pageData.detail}
      banner={pageData.banner}
      notice={notice}
      view={view}
      hasNext={pageData.hasNext}
      detailOpen={selectedItem !== undefined}
      renderedAt={renderedAt}
    />
  );
}

async function loadHumanReviewPageDataInTransaction(
  query: ProductTransactionQuery,
  session: HumanAccountSession,
  selectedItem: string | null,
  view: HumanReviewView
) {
  const page = await humanReviewPageInTransaction(query, session, {
    status: view.status,
    search: view.search,
    sort: view.sort,
    offset: (view.page - 1) * REVIEW_PAGE_SIZE
  });
  const rows = page.rows;
  const detail = selectedItem
    ? await humanReviewDetailInTransaction(query, session, selectedItem)
    : null;
  const banner = await humanReviewAccountBannerInTransaction(query, session);
  return { rows, detail, banner, hasNext: page.hasNext };
}

function humanReviewNotice(
  params: Record<string, string | string[] | undefined> | undefined
): HumanReviewNotice | null {
  const error = firstSearchParam(params?.error);
  if (error) {
    const failedActionKind = firstSearchParam(params?.failedActionKind);
    return {
      kind: "error",
      message: `Action failed: ${error.replaceAll("_", " ")}.`,
      failedActionKind:
        failedActionKind === "file_upload" ? "file_upload" : undefined
    };
  }

  const notice = firstSearchParam(params?.notice);
  if (notice === "answer_submitted") {
    const action = firstSearchParam(params?.action);
    const subject = firstSearchParam(params?.subject);
    const inputItemId = firstSearchParam(params?.undo_target);
    const callerId = firstSearchParam(params?.undo_actor);
    const outputResultId = firstSearchParam(params?.undo_result);
    return {
      kind: "notice",
      message: completedActionNotice(action, subject),
      ...(inputItemId && callerId && outputResultId
        ? { undo: { inputItemId, callerId, outputResultId } }
        : {})
    };
  }
  if (notice === "answer_undone") {
    return { kind: "notice", message: "Answer undone before caller read." };
  }
  if (notice === "bulk_answered") {
    const answered = firstSearchParam(params?.answered) ?? "0";
    const failed = firstSearchParam(params?.failed) ?? "0";
    return {
      kind: "notice",
      message: `Bulk action complete: ${answered} answered, ${failed} failed.`
    };
  }

  return null;
}

function completedActionNotice(
  action: string | undefined,
  subject: string | undefined
) {
  if (action === "Approve to send") {
    return subject
      ? `Draft approved for sending: “${subject}”.`
      : "Draft approved for sending.";
  }
  if (action && subject) {
    return `${action} completed for “${subject}”.`;
  }
  return action ? `${action} completed.` : "Answer submitted.";
}
