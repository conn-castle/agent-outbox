import type { HumanAccountSession } from "./human-session.ts";
import {
  REVIEW_PAGE_SIZE,
  type HumanReviewDetail,
  type HumanReviewListRow
} from "./human-review.ts";
import type { StatusResult } from "./status.ts";
import type { HumanAccountBannerData } from "./human-review.ts";
import type { HumanAccountIdentityDisplay } from "../shared/account-display.ts";
import {
  browserFixtureCoreReviewDetails,
  fixtureUuid,
  STORYBOARD_USE_CASES
} from "./human-review-fixture-scenarios.ts";
import { browserFixtureDesignReviewDetails } from "./human-review-design-fixture.ts";
export { BROWSER_FIXTURE_REFERENCE_TIME } from "./human-review-design-fixture.ts";
import type { HumanReviewView } from "../shared/human-review-view.ts";

export { humanBrowserFixtureEnabled } from "./human-review-fixture-gate.ts";

const fixtureExistingProviderSubject = "browser-fixture-existing-human";
const fixtureSignupProviderSubject = "browser-fixture-first-time-human";

type BrowserFixtureSessionInput = {
  firstTimeSignup?: boolean;
  providerSubject?: string | null;
};

export type BrowserFixtureStoryboardScenario = {
  inputItemId: string;
  callerItemId: string;
  status: HumanReviewListRow["status"];
  title: string;
  rowType: string;
  caller: string;
  useCase: string;
  coverage: string[];
};

export function browserFixtureSignupHref() {
  const params = new URLSearchParams({
    fixture_signup: "1",
    fixture_provider_subject: fixtureSignupProviderSubject
  });
  return `/human?${params.toString()}`;
}

export function browserFixtureHumanSession(
  input: BrowserFixtureSessionInput = {}
): HumanAccountSession {
  const providerSubject = fixtureProviderSubject(input);
  const accountId = fixtureUuid(`${providerSubject}:account`);
  const userId = fixtureUuid(`${providerSubject}:user`);

  return {
    surface: "human",
    accountId,
    userId,
    role: "owner",
    provisionedAccount: input.firstTimeSignup === true,
    account: {
      accountId,
      label: `Browser fixture account: ${providerSubject}`,
      tier: "hosted_paid",
      billingStatus: "active",
      billingGraceEndsAt: null
    }
  };
}

export type BrowserFixtureResolvedItem = {
  actionDisplay: string;
  callerId: string;
  answeredAt: string;
};

type BrowserFixtureReviewOptions = {
  includePaginationRows?: boolean;
  resolvedItemId?: string;
  resolvedItems?: Record<string, BrowserFixtureResolvedItem>;
  answeredOverlay?: boolean;
};

export function browserFixtureReviewRows(
  options: BrowserFixtureReviewOptions = {}
): HumanReviewListRow[] {
  return browserFixtureReviewDetails(options).map(
    ({ detailsHtml: _details, actions, linkButtons, ...row }) => ({
      ...row,
      linkButtons,
      hasOverflowActions: actions.some((action) => action.overflow)
    })
  );
}

export function browserFixtureReviewPage(
  view: HumanReviewView,
  options: BrowserFixtureReviewOptions = {}
) {
  const effectiveOptions = {
    includePaginationRows:
      options.includePaginationRows ||
      view.page > 1 ||
      view.search.toLowerCase().includes("beyond one hundred")
  };
  const terms = view.search.toLowerCase();
  // Mirrors the production SQL exactly: tag-stripped matching over the three
  // HTML columns plus plain matching on caller item id and caller display name.
  const stripTags = (html: string) => html.replaceAll(/<[^>]*>/g, " ");
  const resolvedItems = options.resolvedItems ?? {};
  const resolvedIds = new Set(
    [options.resolvedItemId, ...Object.keys(resolvedItems)].filter(
      (id): id is string => Boolean(id)
    )
  );
  const filtered = browserFixtureReviewRows(effectiveOptions).filter((row) => {
    const resolved = resolvedIds.has(row.inputItemId);
    const effectiveStatus = resolved ? "answered" : row.status;
    if (effectiveStatus !== view.status) return false;
    if (!terms) return true;
    return [
      stripTags(row.titleHtml),
      stripTags(row.subtitleHtml),
      stripTags(row.summaryHtml),
      row.callerItemId,
      row.caller.displayName
    ].some((field) => field.toLowerCase().includes(terms));
  });
  if (!browserFixtureUsesDesignData())
    filtered.sort((left, right) => {
      if (view.sort === "priority") {
        const weights = { urgent: 0, high: 1, normal: 2, low: 3 };
        const priority = weights[left.priority] - weights[right.priority];
        if (priority !== 0) return priority;
      }
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated || left.inputItemId.localeCompare(right.inputItemId);
    });
  const overlayed = filtered.map((row) =>
    applyFixtureResolvedState(
      row,
      resolvedItems[row.inputItemId],
      resolvedIds.has(row.inputItemId)
    )
  );
  const offset = (view.page - 1) * REVIEW_PAGE_SIZE;
  const window = overlayed.slice(offset, offset + REVIEW_PAGE_SIZE + 1);
  return {
    rows: window.slice(0, REVIEW_PAGE_SIZE),
    hasNext: window.length > REVIEW_PAGE_SIZE
  };
}

export function browserFixtureReviewDetail(
  inputItemId: string | null,
  _options: BrowserFixtureReviewOptions = {}
): HumanReviewDetail | null {
  // Direct item links do not carry the fixture-only dataset flag. Keep tail
  // details addressable so pagination navigation and server-action redirects
  // exercise the same item URL shape as production.
  const details = browserFixtureReviewDetails({ includePaginationRows: true });
  const detail = inputItemId
    ? (details.find((candidate) => candidate.inputItemId === inputItemId) ??
      null)
    : (details[0] ?? null);
  if (!detail || !_options.answeredOverlay) {
    return detail;
  }
  return applyFixtureResolvedState(
    detail,
    _options.resolvedItems?.[detail.inputItemId]
  );
}

function applyFixtureResolvedState<T extends HumanReviewListRow>(
  row: T,
  resolved: BrowserFixtureResolvedItem | undefined,
  isResolved = Boolean(resolved)
): T {
  if (!isResolved) {
    return row;
  }
  return {
    ...row,
    status: "answered",
    ...(resolved
      ? {
          answeredAt: resolved.answeredAt,
          output: {
            outputResultId: fixtureUuid(
              `fixture-resolved-output:${row.inputItemId}`
            ),
            actionValue: "fixture_resolved",
            actionDisplay: resolved.actionDisplay,
            answeredAt: resolved.answeredAt,
            firstReadAt: null,
            readCount: 0,
            undoEligible: true
          },
          bulkActions: [],
          hasOverflowActions: false,
          ...("actions" in row
            ? {
                actions: (
                  row as T & { actions: HumanReviewDetail["actions"] }
                ).actions.map((action) => ({ ...action, answerable: false }))
              }
            : {})
        }
      : {})
  };
}

export function browserFixtureStoryboardDetails(): HumanReviewDetail[] {
  return browserFixtureCoreReviewDetails();
}

export function browserFixtureStoryboardScenarios(): BrowserFixtureStoryboardScenario[] {
  return browserFixtureStoryboardDetails().map((detail) => {
    const useCase = STORYBOARD_USE_CASES[detail.callerItemId];
    if (!useCase) {
      throw new Error(
        `Missing storyboard use case for fixture ${detail.callerItemId}.`
      );
    }
    return {
      inputItemId: detail.inputItemId,
      callerItemId: detail.callerItemId,
      status: detail.status,
      title: plainFixtureText(detail.titleHtml),
      rowType: detail.rowType.display,
      caller: detail.caller.displayName,
      useCase,
      coverage: fixtureCoverage(detail)
    };
  });
}

export function browserFixtureAccountBanner(
  session: HumanAccountSession,
  plan: "free" | "paid" = "paid"
): StatusResult<HumanAccountBannerData> {
  const free = plan === "free";
  return {
    ok: true,
    data: {
      account_id: session.accountId,
      label: session.account.label,
      tier: free ? "hosted_free" : "hosted_paid",
      effective_tier: free ? "free" : "paid",
      billing_status: free ? "not_applicable" : "active",
      grace_ends_at: null,
      file_upload_enabled: !free,
      storage: {
        stored_bytes: free ? 1_280_000 : 24_000,
        limit_name: free
          ? "stored_non_file_queue_payload_bytes"
          : "overall_stored_account_data_bytes",
        limit_bytes: free ? 32_000_000 : 1_000_000_000
      },
      active_limit_blocks: [],
      usage: [
        ...(free
          ? [
              {
                limitName: "input_submissions_per_calendar_month" as const,
                label: "Monthly input submissions",
                used: 184,
                limit: 5_000,
                unit: "submissions" as const,
                resetsAt: "2026-08-01T00:00:00.000Z"
              },
              {
                limitName: "input_submissions_per_day" as const,
                label: "Daily input submissions",
                used: 12,
                limit: 1_000,
                unit: "submissions" as const,
                resetsAt: "2026-07-16T00:00:00.000Z"
              },
              {
                limitName:
                  "authenticated_caller_api_requests_per_calendar_month" as const,
                label: "Monthly caller API requests",
                used: 4628,
                limit: 100_000,
                unit: "requests" as const,
                resetsAt: "2026-08-01T00:00:00.000Z"
              }
            ]
          : []),
        {
          limitName: "queued_input_items",
          label: "Queued input items",
          used: 8,
          limit: free ? 1_000 : null,
          unit: "items",
          resetsAt: null
        }
      ]
    }
  };
}

export function browserFixtureAccountIdentity(): HumanAccountIdentityDisplay {
  return {
    name: "Alex Morgan",
    emailAddress: "alex@example.com",
    signInMethods: ["GitHub"]
  };
}

function fixtureProviderSubject(input: BrowserFixtureSessionInput) {
  const providerSubject = input.providerSubject?.trim();
  if (input.firstTimeSignup && providerSubject) {
    return providerSubject;
  }
  return fixtureExistingProviderSubject;
}

function browserFixtureReviewDetails(
  options: BrowserFixtureReviewOptions = {}
): HumanReviewDetail[] {
  const details = browserFixtureUsesDesignData()
    ? browserFixtureDesignReviewDetails()
    : browserFixtureCoreReviewDetails();
  if (!options.includePaginationRows) {
    return details;
  }
  const template = details[0]!;
  const scenarios = [
    {
      type: "Email Draft",
      icon: "mail",
      title: "Send revised vendor timeline",
      subtitle: "Reply prepared from the approved delivery plan.",
      summary:
        "<p><strong>Send:</strong> “Phase one remains on track for August 18; final QA begins the following Monday.”</p>"
    },
    {
      type: "Calendar Change",
      icon: "calendar",
      title: "Confirm planning review",
      subtitle: "One attendee requested a later start.",
      summary:
        "<p><strong>Move meeting:</strong> Thursday, August 6 · 3:30–4:00 PM ET.</p>"
    },
    {
      type: "Client Update",
      icon: "send",
      title: "Share weekly project status",
      subtitle: "Draft assembled from this week’s completed work.",
      summary:
        "<p><strong>Publish:</strong> “Research is complete. Prototype testing begins tomorrow with no scope change.”</p>"
    },
    {
      type: "Finance Check",
      icon: "check",
      title: "Approve software categorization",
      subtitle: "Recurring vendor charge matched to prior months.",
      summary:
        "<p><strong>Categorize:</strong> Harbor Cloud · $84.00 · Software subscriptions.</p>"
    },
    {
      type: "Follow-up",
      icon: "inbox",
      title: "Send renewal reminder",
      subtitle: "Contract renewal window closes in twelve days.",
      summary:
        "<p><strong>Send:</strong> “Your renewal decision is due August 14. Reply if the term or seat count should change.”</p>"
    },
    {
      type: "Travel Change",
      icon: "calendar",
      title: "Accept itinerary adjustment",
      subtitle: "The original connection is no longer available.",
      summary:
        "<p><strong>Replace flight:</strong> DL 2184 · depart 6:10 PM · arrive 8:02 PM.</p>"
    }
  ] as const;
  const generated = Array.from({ length: 101 }, (_, index) => {
    const sequence = index + 1;
    const isTail = sequence === 101;
    const scenario = scenarios[index % scenarios.length]!;
    return {
      ...template,
      inputItemId: fixtureUuid(`review-page-fixture:${sequence}`),
      callerItemId: `fixture-page-${String(sequence).padStart(3, "0")}`,
      priority: "low" as const,
      rowType: isTail
        ? template.rowType
        : { display: scenario.type, icon: scenario.icon },
      titleHtml: isTail
        ? "<strong>Beyond one hundred review</strong>"
        : `<strong>${scenario.title}</strong>`,
      subtitleHtml: isTail
        ? "Discoverable after the first full review page."
        : scenario.subtitle,
      summaryHtml: isTail
        ? "<p>This review proves that queue items beyond the first 100 remain actionable.</p>"
        : scenario.summary,
      detailsHtml: isTail
        ? "<p>Open and approve this item to verify tail-page review behavior.</p>"
        : `<p>Pagination fixture detail ${sequence}.</p>`,
      actions: template.actions.map((action) =>
        action.value === "approve" ? { ...action, display: "Approve" } : action
      ),
      createdAt: new Date(
        Date.UTC(2026, 5, 30, 0, 101 - sequence)
      ).toISOString(),
      updatedAt: new Date(
        Date.UTC(2026, 5, 30, 0, 101 - sequence)
      ).toISOString()
    };
  });
  return [...details, ...generated];
}

function browserFixtureUsesDesignData() {
  return process.env.AGENT_OUTBOX_BROWSER_COVERAGE_FIXTURE !== "1";
}

function fixtureCoverage(detail: HumanReviewDetail) {
  const coverage = new Set<string>([
    detail.status,
    detail.priority,
    detail.cardVisual?.kind ?? "no visual",
    detail.bulkActions.length > 0 ? "quick action" : "detail required",
    detail.detailsHtml ? "rich detail" : "no detail body",
    detail.linkButtons.length > 0 ? "context links" : "no context links",
    detail.skipDisabled ? "skip disabled" : "skip enabled",
    detail.cornerHtml ? "corner metadata" : "no corner metadata",
    detail.rowAccentColor ? "accent color" : "no accent color"
  ]);
  if (detail.bulkActions.length > 1) coverage.add("multiple quick actions");
  if (detail.linkButtons.length > 1) coverage.add("multiple context links");
  if (detail.actions.some((action) => action.overflow)) {
    coverage.add("overflow actions");
  }
  if (detail.actions.some((action) => !action.answerable)) {
    coverage.add("disabled action");
  }
  for (const action of detail.actions) {
    coverage.add(action.popupKind.replaceAll("_", " "));
    if (action.popupKind === "date_picker") {
      const payload = recordFixtureValue(action.popupPayload);
      coverage.add(payload.mode === "datetime" ? "date and time" : "date");
    }
    if (action.popupKind === "free_text") {
      const payload = recordFixtureValue(action.popupPayload);
      coverage.add(
        payload.multiline === true ? "multiline text" : "single-line text"
      );
      if (typeof payload.default_value === "string") {
        coverage.add("default text");
      }
    }
  }
  if (detail.output) {
    coverage.add(detail.output.firstReadAt ? "caller read" : "caller unread");
    coverage.add(
      detail.output.undoEligible ? "undo available" : "undo disabled"
    );
  }
  return [...coverage];
}

function recordFixtureValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function plainFixtureText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
