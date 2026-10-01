import {
  runProductTransaction,
  setProductTransactionIdentityContext,
  type ProductTransactionQuery
} from "./database.ts";
import {
  humanReviewAccountBannerInTransaction,
  humanReviewCardInTransaction,
  humanReviewDetailInTransaction,
  humanReviewPageInTransaction,
  humanReviewTypeOptionsInTransaction,
  REVIEW_PAGE_SIZE,
  type HumanReviewDetail,
  type HumanReviewListRow
} from "./human-review.ts";
import {
  runHumanAccountTransaction,
  type HumanAccountSession,
  type HumanAccountTransactionResult,
  type HumanSessionInput
} from "./human-session.ts";
import {
  humanReviewViewFromRecord,
  type HumanReviewView
} from "../shared/human-review-view.ts";

export type HumanReviewPageLoad = {
  view: HumanReviewView;
  rows: HumanReviewListRow[];
  detail: HumanReviewDetail | null;
  banner: Awaited<ReturnType<typeof humanReviewAccountBannerInTransaction>>;
  typeOptions: string[];
  hasNext: boolean;
  totalCount: number;
};

export async function loadHumanReviewPage(
  input: HumanSessionInput,
  request: {
    selectedItem: string | null;
    view: HumanReviewView;
    cardLink: { callerId: string; callerItemId: string } | null;
  },
  options: {
    runTransaction?: typeof runProductTransaction;
  } = {}
): Promise<HumanAccountTransactionResult<HumanReviewPageLoad>> {
  const runTransaction = options.runTransaction ?? runProductTransaction;
  const cardLink = request.cardLink;
  if (!cardLink) {
    return runHumanAccountTransaction(
      input,
      (query, session) =>
        loadHumanReviewPageDataInTransaction(
          query,
          session,
          request.selectedItem,
          request.view,
          null
        ),
      { runTransaction }
    );
  }

  // Bootstrap updates last_seen_at, so the session transaction stays read
  // committed. A repeatable-read session would fail concurrent page loads
  // with a serialization error. The linked lookup, queue page, and detail
  // are a second read-only transaction so they share one snapshot.
  const sessionResult = await runHumanAccountTransaction(
    input,
    async () => null,
    { runTransaction }
  );
  if (!sessionResult.ok) return sessionResult;
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString || !input.clerkUserId) {
    return {
      ok: false,
      status: 503,
      code: "database_configuration_missing",
      message: "Human account database configuration is unavailable."
    };
  }

  const data = await runTransaction(
    connectionString,
    {
      requestId: input.requestId,
      authSurface: "human",
      accountId: sessionResult.session.accountId,
      userId: sessionResult.session.userId,
      clerkUserId: input.clerkUserId
    },
    async (query) => {
      await setProductTransactionIdentityContext(query, {
        authSurface: "human",
        accountId: sessionResult.session.accountId,
        userId: sessionResult.session.userId
      });
      return loadHumanReviewPageDataInTransaction(
        query,
        sessionResult.session,
        request.selectedItem,
        request.view,
        cardLink
      );
    },
    { isolationLevel: "repeatable read" }
  );
  return { ok: true, session: sessionResult.session, data };
}

async function loadHumanReviewPageDataInTransaction(
  query: ProductTransactionQuery,
  session: HumanAccountSession,
  selectedItem: string | null,
  view: HumanReviewView,
  cardLink: { callerId: string; callerItemId: string } | null
): Promise<HumanReviewPageLoad> {
  if (cardLink) {
    const card = await humanReviewCardInTransaction(
      query,
      session,
      cardLink.callerId,
      cardLink.callerItemId
    );
    view = {
      ...humanReviewViewFromRecord(undefined),
      status: card?.status ?? "pending",
      page: card?.page ?? 1
    };
    selectedItem = card?.inputItemId ?? null;
  }
  const page = await humanReviewPageInTransaction(query, session, {
    status: view.status,
    search: view.search,
    priorities: view.priorities,
    types: view.types,
    sorts: view.sorts,
    offset: (view.page - 1) * REVIEW_PAGE_SIZE
  });
  const detail = selectedItem
    ? await humanReviewDetailInTransaction(query, session, selectedItem)
    : null;
  const banner = await humanReviewAccountBannerInTransaction(query, session);
  const typeOptions = await humanReviewTypeOptionsInTransaction(
    query,
    session,
    view.status
  );
  return {
    view,
    rows: page.rows,
    detail,
    banner,
    typeOptions,
    hasNext: page.hasNext,
    totalCount: page.totalCount
  };
}
