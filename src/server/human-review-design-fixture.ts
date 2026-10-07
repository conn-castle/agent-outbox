import { createHash } from "node:crypto";

import designFixture from "./human-review-design-fixture-data.json" with { type: "json" };
import type { HumanReviewAction, HumanReviewDetail } from "./human-review.ts";
import {
  parseInputSubmission,
  type NormalizedInputAction,
  type NormalizedInputSubmission
} from "./input-schema.ts";

const DESIGN_CALLER_ID = "00000000-0000-4000-8000-000000000504";
const DESIGN_FIXTURE_ANCHOR_MS = Date.UTC(2026, 7, 15, 18, 0, 0);

/**
 * Frozen "now" for every browser-fixture render. Marketing screenshots are
 * hash-attested per release and re-captured by `make release-check`, so any
 * wall-clock input to the page would change the captured pixels on a later
 * date without a code change. Anchored 42 minutes after the newest fixture row
 * to match the leading row's authored corner copy.
 */
export const BROWSER_FIXTURE_REFERENCE_TIME = new Date(
  DESIGN_FIXTURE_ANCHOR_MS + 42 * 60_000
).toISOString();

export function browserFixtureDesignReviewDetails(): HumanReviewDetail[] {
  return designFixture.rows.map((fixture, rowIndex) => {
    const parsed = parseInputSubmission(fixture.input);
    if (!parsed.ok) {
      throw new Error(
        `Invalid canonical design fixture ${fixture.scenario_id}: ${JSON.stringify(parsed.error)}`
      );
    }
    const updatedAt = new Date(
      DESIGN_FIXTURE_ANCHOR_MS - rowIndex * 60_000
    ).toISOString();
    return detailFromNormalizedSubmission(parsed.submission, {
      inputItemId: designUuid(fixture.scenario_id),
      updatedAt
    });
  });
}

export function detailFromNormalizedSubmission(
  input: NormalizedInputSubmission,
  metadata: {
    inputItemId: string;
    updatedAt: string;
  }
): HumanReviewDetail {
  const actions = input.actions.map((action) => fixtureAction(action));
  return {
    inputItemId: metadata.inputItemId,
    callerItemId: input.callerItemId,
    status: "pending",
    priority: input.priority,
    currentRevision: 1,
    rowType: input.rowType,
    rowAccentColor: input.rowAccentColor,
    titleHtml: input.titleHtml,
    subtitleHtml: input.subtitleHtml,
    cornerHtml: input.cornerHtml,
    cardTime: input.cardTime,
    summaryHtml: input.summaryHtml,
    detailsHtml: input.detailsHtml,
    cardVisual: input.cardVisual,
    skipDisabled: input.skipDisabled,
    createdAt: metadata.updatedAt,
    updatedAt: metadata.updatedAt,
    answeredAt: null,
    caller: {
      callerId: DESIGN_CALLER_ID,
      displayName: "Agent Outbox design fixture",
      slug: "design-fixture",
      revoked: false
    },
    output: null,
    bulkActions: actions.map((action) => ({
      displayOrder: action.displayOrder,
      display: action.display,
      icon: action.icon,
      value: action.value,
      tone: action.tone,
      style: action.style,
      popupKind: action.popupKind,
      overflow: action.overflow
    })),
    linkButtons: input.linkButtons.map((link) => ({ ...link })),
    actions
  };
}

function fixtureAction(action: NormalizedInputAction): HumanReviewAction {
  // Normalized input keeps popupKind and popupPayload in separate fields, so
  // TypeScript cannot narrow them to the persisted popup union.
  return {
    displayOrder: action.displayOrder,
    display: action.display,
    icon: action.icon,
    value: action.value,
    overflow: action.overflow,
    tone: action.tone,
    style: action.style,
    answerable: true,
    options: action.options.map((option) => ({ ...option })),
    popupKind: action.popupKind,
    popupPayload: action.popupKind === "none" ? {} : action.popupPayload
  } as HumanReviewAction;
}

function designUuid(seed: string) {
  const hash = createHash("sha256")
    .update(`design-fixture:${seed}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(
    13,
    16
  )}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
