import { auth, clerkClient, type User } from "@clerk/nextjs/server";

import {
  type HumanReviewNotice,
  ReviewWorkspace
} from "../../src/components/human/ReviewWorkspace";
import { createCorrelationId } from "../../src/server/correlation";
import type { ProductTransactionQuery } from "../../src/server/database";
import {
  BROWSER_FIXTURE_REFERENCE_TIME,
  browserFixtureAccountBanner,
  browserFixtureAccountIdentity,
  browserFixtureHumanSession,
  browserFixtureReviewDetail,
  browserFixtureReviewPage,
  humanBrowserFixtureEnabled
} from "../../src/server/human-review-fixture";
import { readFixtureResolvedItems } from "../../src/server/human-review-fixture-state";
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
import {
  humanAccountIdentityOrFallback,
  type HumanAccountIdentityDisplay
} from "../../src/shared/account-display";

export const dynamic = "force-dynamic";

export default async function HumanReviewPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const fixtureEnabled = humanBrowserFixtureEnabled();
  // Fixture renders must stay byte-stable: the release gate re-captures the
  // marketing screenshots and compares hashes, so relative row timestamps
  // cannot follow the wall clock.
  const renderedAt = fixtureEnabled
    ? BROWSER_FIXTURE_REFERENCE_TIME
    : new Date().toISOString();
  const selectedItem = firstSearchParam(params?.item);
  const composeAction = firstSearchParam(params?.compose);
  const notice = humanReviewNotice(params);
  const view = humanReviewViewFromRecord(params);

  if (fixtureEnabled) {
    const resolvedItems = await readFixtureResolvedItems();
    const fixtureOptions = {
      includePaginationRows:
        firstSearchParam(params?.fixture_dataset) === "pagination",
      resolvedItemId: firstSearchParam(params?.resolved),
      resolvedItems,
      answeredOverlay: view.status === "answered"
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
        identity={browserFixtureAccountIdentity()}
        rows={fixturePage.rows}
        detail={
          selectedItem
            ? browserFixtureReviewDetail(selectedItem, fixtureOptions)
            : null
        }
        banner={browserFixtureAccountBanner(
          session,
          firstSearchParam(params?.fixture_plan) === "free" ? "free" : "paid"
        )}
        notice={notice}
        view={view}
        hasNext={fixturePage.hasNext}
        detailOpen={selectedItem !== undefined}
        composeAction={composeAction}
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
  const [transaction, clerkIdentity] = await Promise.all([
    runHumanAccountTransaction(
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
    ),
    loadClerkAccountIdentity(session.userId)
  ]);

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
      identity={humanAccountIdentityOrFallback(
        clerkIdentity,
        humanSession.account.label
      )}
      rows={pageData.rows}
      detail={pageData.detail}
      banner={pageData.banner}
      notice={notice}
      view={view}
      hasNext={pageData.hasNext}
      detailOpen={selectedItem !== undefined}
      composeAction={composeAction}
      renderedAt={renderedAt}
    />
  );
}

const CLERK_ACCOUNT_IDENTITY_TIMEOUT_MS = 3_000;

async function loadClerkAccountIdentity(
  userId: string
): Promise<HumanAccountIdentityDisplay | null> {
  try {
    return humanAccountIdentity(
      await withDeadline(
        (async () => (await clerkClient()).users.getUser(userId))(),
        CLERK_ACCOUNT_IDENTITY_TIMEOUT_MS
      )
    );
  } catch {
    return null;
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("clerk_account_identity_timeout"));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function humanAccountIdentity(user: User): HumanAccountIdentityDisplay {
  const emailAddress = user.primaryEmailAddress?.emailAddress ?? null;
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.username ||
    emailAddress;
  const signInMethods = [
    ...new Set(
      user.externalAccounts.map((account) => providerLabel(account.provider))
    ),
    ...(user.passwordEnabled ? ["Password"] : [])
  ];
  return { name, emailAddress, signInMethods };
}

function providerLabel(provider: string) {
  const normalized = provider.replace(/^oauth_/, "");
  const known: Record<string, string> = {
    github: "GitHub",
    google: "Google",
    apple: "Apple",
    microsoft: "Microsoft",
    linkedin_oidc: "LinkedIn"
  };
  return (
    known[normalized] ??
    normalized
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
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
