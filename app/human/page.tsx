import { auth, clerkClient, type User } from "@clerk/nextjs/server";

import {
  type HumanReviewNotice,
  ReviewWorkspace
} from "../../src/components/human/ReviewWorkspace";
import { createCorrelationId } from "../../src/server/correlation";
import {
  BROWSER_FIXTURE_REFERENCE_TIME,
  browserFixtureAccountBanner,
  browserFixtureAccountIdentity,
  browserFixtureHumanSession,
  browserFixtureReviewDetail,
  browserFixtureReviewCard,
  browserFixtureReviewPage,
  browserFixtureReviewTypeOptions,
  humanBrowserFixtureEnabled
} from "../../src/server/human-review-fixture";
import { readFixtureResolvedItems } from "../../src/server/human-review-fixture-state";
import { loadHumanReviewPage } from "../../src/server/human-review-page";
import { requiredHumanSessionConfiguration } from "../../src/server/human-session";
import { MissingConfigurationPanel } from "../../src/server/ui";
import {
  firstSearchParam,
  humanReviewViewFromRecord
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
  let selectedItem = firstSearchParam(params?.item);
  const cardLink =
    params?.caller_id !== undefined || params?.caller_item_id !== undefined
      ? {
          callerId: firstSearchParam(params?.caller_id) ?? "",
          callerItemId: firstSearchParam(params?.caller_item_id) ?? ""
        }
      : null;
  const composeAction = firstSearchParam(params?.compose);
  const notice = humanReviewNotice(params);
  let view = humanReviewViewFromRecord(params);

  if (fixtureEnabled) {
    const resolvedItems = await readFixtureResolvedItems();
    const fixtureOptions = {
      includePaginationRows:
        firstSearchParam(params?.fixture_dataset) === "pagination",
      resolvedItemId: firstSearchParam(params?.resolved),
      resolvedItems
    };
    const session = browserFixtureHumanSession({
      firstTimeSignup: firstSearchParam(params?.fixture_signup) === "1",
      providerSubject: firstSearchParam(params?.fixture_provider_subject)
    });
    if (cardLink) {
      const card = browserFixtureReviewCard(
        cardLink.callerId,
        cardLink.callerItemId,
        fixtureOptions
      );
      view = {
        ...humanReviewViewFromRecord(undefined),
        status: card?.status ?? "pending",
        page: card?.page ?? 1
      };
      selectedItem = card?.inputItemId;
      if (card?.page && card.page > 1)
        fixtureOptions.includePaginationRows = true;
    }
    const fixturePage = browserFixtureReviewPage(view, fixtureOptions);
    return (
      <ReviewWorkspace
        key={session.accountId}
        session={session}
        identity={browserFixtureAccountIdentity()}
        rows={fixturePage.rows}
        typeOptions={browserFixtureReviewTypeOptions(view, fixtureOptions)}
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
        totalCount={fixturePage.totalCount}
        detailOpen={cardLink !== null || selectedItem !== undefined}
        composeAction={composeAction}
        renderedAt={renderedAt}
      />
    );
  }

  const missing = requiredHumanSessionConfiguration();
  if (missing.length > 0) {
    return (
      <div className="ph-no-capture">
        <MissingConfigurationPanel
          title="Human review route is not configured"
          missing={missing}
        />
      </div>
    );
  }

  const returnParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    for (const entry of Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value]) {
      returnParams.append(key, entry);
    }
  }
  const session = await auth.protect({
    unauthenticatedUrl: `/sign-in?${new URLSearchParams({ redirect_url: `/human?${returnParams}` })}`
  });
  const [transaction, clerkIdentity] = await Promise.all([
    loadHumanReviewPage(
      {
        clerkUserId: session.userId,
        requestId: createCorrelationId("human_req"),
        route: "/human",
        method: "GET"
      },
      {
        selectedItem: selectedItem ?? null,
        view,
        cardLink
      }
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
      typeOptions={pageData.typeOptions}
      detail={pageData.detail}
      banner={pageData.banner}
      notice={notice}
      view={pageData.view}
      hasNext={pageData.hasNext}
      totalCount={pageData.totalCount}
      detailOpen={cardLink !== null || selectedItem !== undefined}
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

function humanReviewNotice(
  params: Record<string, string | string[] | undefined> | undefined
): HumanReviewNotice | null {
  const subject = firstSearchParam(params?.subject)?.slice(0, 160);
  const action = firstSearchParam(params?.action)?.slice(0, 160);
  const quotedSubject = subject ? `“${subject}”` : "this review";
  const error = firstSearchParam(params?.error);
  if (error) {
    const failedActionKind = firstSearchParam(params?.failedActionKind);
    return {
      kind: "error",
      message: `Action for ${quotedSubject} failed: ${error.replaceAll("_", " ")}.`,
      failedActionKind:
        failedActionKind === "file_upload" ? "file_upload" : undefined
    };
  }

  const notice = firstSearchParam(params?.notice);
  if (notice === "answer_submitted") {
    const inputItemId = firstSearchParam(params?.undo_target);
    const callerId = firstSearchParam(params?.undo_actor);
    const outputResultId = firstSearchParam(params?.undo_result);
    return {
      kind: "notice",
      message: `Saved ${action ? `${action} for ` : "response for "}${quotedSubject}.`,
      ...(action ? { actionLabel: action } : {}),
      ...(inputItemId && callerId && outputResultId
        ? { undo: { inputItemId, callerId, outputResultId } }
        : {})
    };
  }
  if (notice === "answer_undone") {
    return {
      kind: "notice",
      message: `Restored ${quotedSubject} to its prior queue position.`
    };
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
