import { createHash } from "node:crypto";

import type { HumanAccountSession } from "./human-session.ts";
import {
  REVIEW_PAGE_SIZE,
  type HumanReviewDetail,
  type HumanReviewListRow
} from "./human-review.ts";
import type { AccountStatusData, StatusResult } from "./status.ts";
export { humanBrowserFixtureEnabled } from "./human-review-fixture-gate.ts";

const fixtureCallerId = "00000000-0000-4000-8000-000000000503";
const fixtureExistingProviderSubject = "browser-fixture-existing-human";
const fixtureSignupProviderSubject = "browser-fixture-first-time-human";

type BrowserFixtureSessionInput = {
  firstTimeSignup?: boolean;
  providerSubject?: string | null;
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

export function browserFixtureReviewRows(): HumanReviewListRow[] {
  return browserFixtureReviewDetails().map(
    ({ detailsHtml: _details, ...row }) => row
  );
}

export function browserFixtureReviewPage(view: {
  search: string;
  status: "all" | "pending" | "answered";
  sort: "priority" | "updated_at";
  page: number;
}) {
  const terms = view.search.toLowerCase();
  // Mirrors the production SQL exactly: tag-stripped matching over the three
  // HTML columns plus plain matching on caller item id and caller display name.
  const stripTags = (html: string) => html.replaceAll(/<[^>]*>/g, " ");
  const filtered = browserFixtureReviewRows().filter((row) => {
    if (view.status !== "all" && row.status !== view.status) return false;
    if (!terms) return true;
    return [
      stripTags(row.titleHtml),
      stripTags(row.subtitleHtml),
      stripTags(row.summaryHtml),
      row.callerItemId,
      row.caller.displayName
    ].some((field) => field.toLowerCase().includes(terms));
  });
  filtered.sort((left, right) => {
    if (view.sort === "priority") {
      const weights = { urgent: 0, high: 1, normal: 2, low: 3 };
      const priority = weights[left.priority] - weights[right.priority];
      if (priority !== 0) return priority;
    }
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    return updated || left.inputItemId.localeCompare(right.inputItemId);
  });
  const offset = (view.page - 1) * REVIEW_PAGE_SIZE;
  const window = filtered.slice(offset, offset + REVIEW_PAGE_SIZE + 1);
  return {
    rows: window.slice(0, REVIEW_PAGE_SIZE),
    hasNext: window.length > REVIEW_PAGE_SIZE
  };
}

export function browserFixtureReviewDetail(
  inputItemId: string | null
): HumanReviewDetail | null {
  const details = browserFixtureReviewDetails();
  if (inputItemId) {
    return details.find((detail) => detail.inputItemId === inputItemId) ?? null;
  }
  return details[0] ?? null;
}

export function browserFixtureAccountBanner(
  session: HumanAccountSession
): StatusResult<AccountStatusData> {
  return {
    ok: true,
    data: {
      account_id: session.accountId,
      label: session.account.label,
      tier: "hosted_paid",
      effective_tier: "paid",
      billing_status: "active",
      grace_ends_at: null,
      file_upload_enabled: true,
      storage: {
        stored_bytes: 24_000,
        limit_name: "overall_stored_account_data_bytes",
        limit_bytes: 1_000_000_000
      },
      active_limit_blocks: []
    }
  };
}

function fixtureProviderSubject(input: BrowserFixtureSessionInput) {
  const providerSubject = input.providerSubject?.trim();
  if (input.firstTimeSignup && providerSubject) {
    return providerSubject;
  }
  return fixtureExistingProviderSubject;
}

function fixtureUuid(seed: string) {
  const hash = createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(
    13,
    16
  )}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function browserFixtureReviewDetails(): HumanReviewDetail[] {
  const details: HumanReviewDetail[] = [
    {
      inputItemId: "00000000-0000-4000-8000-000000000511",
      callerItemId: "steward-brief-101",
      status: "pending",
      priority: "urgent",
      currentRevision: 3,
      rowType: { display: "Steward Brief", icon: "inbox" },
      rowAccentColor: "#0f766e",
      titleHtml: "<strong>Review neighborhood permit brief</strong>",
      subtitleHtml: "A resident-facing summary needs a final human check.",
      cornerHtml: "Rev 3",
      summaryHtml:
        "<p>Confirm the brief is accurate, calm, and ready for handoff.</p>",
      detailsHtml:
        "<p>The system drafted a short permit explanation from structured notes. Verify the recommendation, edit only if the popup asks for it, and keep the response generic.</p><ul><li>No source-system action is performed here.</li><li>The caller receives only the selected answer value.</li></ul>",
      cardVisual: {
        kind: "numeric_bar",
        payload: {
          label: "Confidence",
          value: 82,
          display: "82",
          unit: "%",
          min_value: 0,
          max_value: 100
        }
      },
      skipDisabled: false,
      createdAt: "2026-07-01T13:00:00.000Z",
      updatedAt: "2026-07-01T13:20:00.000Z",
      answeredAt: null,
      caller: fixtureCaller(),
      output: null,
      bulkActions: [
        {
          displayOrder: 0,
          display: "Approve",
          icon: "check",
          value: "approve"
        }
      ],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Open context",
          icon: "external-link",
          url: "https://example.com/context/steward-brief-101"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Approve",
          icon: "check",
          value: "approve",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Request edit",
          icon: "send",
          value: "request_edit",
          overflow: false,
          popupKind: "free_text",
          popupPayload: {
            label: "Requested change",
            placeholder: "Name the one change needed before handoff.",
            multiline: true,
            min_length: 4,
            max_length: 240
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 2,
          display: "Attach evidence",
          icon: "upload",
          value: "attach_evidence",
          overflow: false,
          popupKind: "file_upload",
          popupPayload: {
            label: "Evidence file",
            accept_mime_types: ["application/pdf", "text/plain"]
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 3,
          display: "Set review lane",
          icon: "chevron-down",
          value: "set_lane",
          overflow: true,
          popupKind: "single_select",
          popupPayload: { label: "Review lane" },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Policy",
              value: "policy",
              icon: "file"
            },
            {
              displayOrder: 1,
              display: "Operations",
              value: "operations",
              icon: "inbox"
            }
          ]
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000512",
      callerItemId: "steward-check-202",
      status: "pending",
      priority: "high",
      currentRevision: 1,
      rowType: { display: "Decision Check", icon: "calendar" },
      rowAccentColor: "hsl(32, 86%, 43%)",
      titleHtml: "Choose follow-up window",
      subtitleHtml: "The caller needs a review date before continuing.",
      cornerHtml: "Today",
      summaryHtml:
        "<p>Select the acceptable timing metadata. This does not schedule anything.</p>",
      detailsHtml:
        "<p>The date picker metadata is displayed here for human review.</p>",
      cardVisual: {
        kind: "progress_ring",
        payload: {
          label: "Readiness",
          value: 6,
          display: "6 of 10",
          unit: null,
          min_value: 0,
          max_value: 10,
          color: "rgb(217, 119, 6)"
        }
      },
      skipDisabled: true,
      createdAt: "2026-07-01T12:10:00.000Z",
      updatedAt: "2026-07-01T12:55:00.000Z",
      answeredAt: null,
      caller: fixtureCaller(),
      output: null,
      bulkActions: [
        {
          displayOrder: 0,
          display: "Approve",
          icon: "check",
          value: "approve"
        }
      ],
      linkButtons: [],
      actions: [
        {
          displayOrder: 0,
          display: "Approve",
          icon: "check",
          value: "approve",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Pick date",
          icon: "calendar",
          value: "pick_date",
          overflow: false,
          popupKind: "date_picker",
          popupPayload: {
            label: "Follow-up date",
            mode: "date",
            placeholder: "YYYY-MM-DD",
            display_timezone: "UTC",
            min_value: "2026-07-01",
            max_value: "2026-07-31"
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 2,
          display: "Pick date and time",
          icon: "clock",
          value: "pick_datetime",
          overflow: false,
          popupKind: "date_picker",
          popupPayload: {
            label: "Follow-up instant",
            mode: "datetime",
            placeholder: "UTC datetime",
            display_timezone: "UTC",
            min_value: "2026-07-01T00:00:00.000Z",
            max_value: "2026-07-31T23:59:59.000Z"
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 3,
          display: "Select checks",
          icon: "check",
          value: "select_checks",
          overflow: true,
          popupKind: "multi_select",
          popupPayload: {
            label: "Completed checks",
            min_selected: 1,
            max_selected: 2
          },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Facts reviewed",
              value: "facts_reviewed",
              icon: "check"
            },
            {
              displayOrder: 1,
              display: "Tone reviewed",
              value: "tone_reviewed",
              icon: "check"
            }
          ]
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000515",
      callerItemId: "security-render-505",
      status: "pending",
      priority: "normal",
      currentRevision: 1,
      rowType: { display: "Security Probe", icon: "not-a-supported-icon" },
      rowAccentColor: "url(https://example.com/unsafe-color)",
      titleHtml: "Renderer boundary probe",
      subtitleHtml:
        "&lt;script&gt;fixtureUnsafeScript()&lt;/script&gt; stays text.",
      cornerHtml: null,
      summaryHtml:
        "&lt;svg&gt;&lt;foreignObject&gt;bad&lt;/foreignObject&gt;&lt;/svg&gt;",
      detailsHtml:
        "&lt;form action='https://example.com'&gt;&lt;input name='x'&gt;&lt;/form&gt;&lt;video src='https://example.com/movie.mp4'&gt;&lt;/video&gt;&lt;CallerInjectedWidget /&gt;",
      cardVisual: {
        kind: "pill",
        payload: {
          text: "Safe fallback",
          icon: "not-a-supported-icon",
          color: "var(--caller-controlled-color)"
        }
      },
      skipDisabled: false,
      createdAt: "2026-07-01T11:30:00.000Z",
      updatedAt: "2026-07-01T11:50:00.000Z",
      answeredAt: null,
      caller: fixtureCaller(),
      output: null,
      bulkActions: [
        {
          displayOrder: 0,
          display: "Escalate",
          icon: "send",
          value: "approve"
        }
      ],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Blocked javascript link",
          icon: "external-link",
          url: "javascript:alert(1)"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Escalate",
          icon: "send",
          value: "approve",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Attach file",
          icon: "upload",
          value: "attach_file",
          overflow: true,
          popupKind: "file_upload",
          popupPayload: {
            label: "Phase 7 file upload",
            component: "CallerInjectedUploader"
          },
          answerable: false,
          options: []
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000513",
      callerItemId: "steward-result-303",
      status: "answered",
      priority: "normal",
      currentRevision: 2,
      rowType: { display: "Outcome Review", icon: "check" },
      rowAccentColor: "#2563eb",
      titleHtml: "Answered summary verification",
      subtitleHtml: "Waiting for caller acknowledgement.",
      cornerHtml: null,
      summaryHtml: "<p>The selected answer is available to the caller.</p>",
      detailsHtml:
        "<p>This item remains visible until caller acknowledgement or cleanup.</p>",
      cardVisual: {
        kind: "pill",
        payload: {
          text: "Answered",
          icon: "check",
          color: "#2563eb"
        }
      },
      skipDisabled: false,
      createdAt: "2026-07-01T11:00:00.000Z",
      updatedAt: "2026-07-01T11:45:00.000Z",
      answeredAt: "2026-07-01T11:45:00.000Z",
      caller: fixtureCaller(),
      output: {
        outputResultId: "00000000-0000-4000-8000-000000000599",
        actionValue: "approve",
        answeredAt: "2026-07-01T11:45:00.000Z",
        firstReadAt: null,
        readCount: 0,
        undoEligible: true
      },
      bulkActions: [],
      linkButtons: [],
      actions: []
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000514",
      callerItemId: "steward-read-404",
      status: "answered",
      priority: "low",
      currentRevision: 1,
      rowType: { display: "Read Result", icon: "check" },
      rowAccentColor: "#334155",
      titleHtml: "Caller already read this answer",
      subtitleHtml: "Undo is disabled after caller read.",
      cornerHtml: null,
      summaryHtml: "<p>The caller has read the answer once.</p>",
      detailsHtml:
        "<p>This answered item demonstrates the no-undo-after-read state.</p>",
      cardVisual: {
        kind: "pill",
        payload: {
          text: "Read",
          icon: "check",
          color: "#334155"
        }
      },
      skipDisabled: false,
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:30:00.000Z",
      answeredAt: "2026-07-01T10:20:00.000Z",
      caller: fixtureCaller(),
      output: {
        outputResultId: "00000000-0000-4000-8000-000000000598",
        actionValue: "approve",
        answeredAt: "2026-07-01T10:20:00.000Z",
        firstReadAt: "2026-07-01T10:30:00.000Z",
        readCount: 1,
        undoEligible: false
      },
      bulkActions: [],
      linkButtons: [],
      actions: []
    }
  ];
  const template = details[0]!;
  const generated = Array.from({ length: 101 }, (_, index) => {
    const sequence = index + 1;
    const isTail = sequence === 101;
    return {
      ...template,
      inputItemId: fixtureUuid(`review-page-fixture:${sequence}`),
      callerItemId: `fixture-page-${String(sequence).padStart(3, "0")}`,
      priority: "low" as const,
      titleHtml: isTail
        ? "<strong>Beyond one hundred review</strong>"
        : `<strong>Pagination fixture ${sequence}</strong>`,
      subtitleHtml: isTail
        ? "Discoverable after the first full review page."
        : `Deterministic pagination row ${sequence}.`,
      summaryHtml: isTail
        ? "<p>This review proves that queue items beyond the first 100 remain actionable.</p>"
        : `<p>Pagination fixture summary ${sequence}.</p>`,
      detailsHtml: isTail
        ? "<p>Open and approve this item to verify tail-page review behavior.</p>"
        : `<p>Pagination fixture detail ${sequence}.</p>`,
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

function fixtureCaller() {
  return {
    callerId: fixtureCallerId,
    displayName: "Steward Operations",
    slug: "steward-operations",
    revoked: false
  };
}
