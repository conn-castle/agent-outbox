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
  browserFixtureReviewRows,
  humanBrowserFixtureEnabled
} from "../../src/server/human-review-fixture";
import {
  humanReviewAccountBannerInTransaction,
  humanReviewDetailInTransaction,
  humanReviewListInTransaction
} from "../../src/server/human-review";
import {
  type HumanAccountSession,
  requiredHumanSessionConfiguration,
  runHumanAccountTransaction
} from "../../src/server/human-session";
import { MissingConfigurationPanel } from "../../src/server/ui";

export const dynamic = "force-dynamic";

export default async function HumanReviewPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const selectedItem = firstParam(params?.item);
  const notice = humanReviewNotice(params);

  if (humanBrowserFixtureEnabled()) {
    const session = browserFixtureHumanSession({
      firstTimeSignup: firstParam(params?.fixture_signup) === "1",
      providerSubject: firstParam(params?.fixture_provider_subject)
    });
    return (
      <ReviewWorkspace
        session={session}
        rows={browserFixtureReviewRows()}
        detail={browserFixtureReviewDetail(selectedItem ?? null)}
        banner={browserFixtureAccountBanner(session)}
        notice={notice}
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
        selectedItem ?? null
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
      session={humanSession}
      rows={pageData.rows}
      detail={pageData.detail}
      banner={pageData.banner}
      notice={notice}
    />
  );
}

async function loadHumanReviewPageDataInTransaction(
  query: ProductTransactionQuery,
  session: HumanAccountSession,
  selectedItem: string | null
) {
  const rows = await humanReviewListInTransaction(query, session, {
    status: "all",
    sort: "priority",
    limit: 100
  });
  const selected = selectedItem ?? rows[0]?.inputItemId ?? null;
  const detail = selected
    ? await humanReviewDetailInTransaction(query, session, selected)
    : null;
  const banner = await humanReviewAccountBannerInTransaction(query, session);
  return { rows, detail, banner };
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function humanReviewNotice(
  params: Record<string, string | string[] | undefined> | undefined
): HumanReviewNotice | null {
  const error = firstParam(params?.error);
  if (error) {
    const failedActionKind = firstParam(params?.failedActionKind);
    return {
      kind: "error",
      message: `Action failed: ${error.replaceAll("_", " ")}.`,
      failedActionKind:
        failedActionKind === "file_upload" ? "file_upload" : undefined
    };
  }

  const notice = firstParam(params?.notice);
  if (notice === "answer_submitted") {
    const action = firstParam(params?.action);
    return {
      kind: "notice",
      message: action ? `Answer submitted: ${action}.` : "Answer submitted."
    };
  }
  if (notice === "answer_undone") {
    return { kind: "notice", message: "Answer undone before caller read." };
  }
  if (notice === "bulk_answered") {
    const answered = firstParam(params?.answered) ?? "0";
    const failed = firstParam(params?.failed) ?? "0";
    return {
      kind: "notice",
      message: `Bulk action complete: ${answered} answered, ${failed} failed.`
    };
  }

  return null;
}
