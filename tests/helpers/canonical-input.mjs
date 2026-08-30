import assert from "node:assert/strict";

import {
  canonicalInputForms,
  parseInputSubmission
} from "../../src/server/input-schema.ts";

/**
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {import("../../src/server/input-schema.ts").NormalizedInputSubmission} NormalizedInputSubmission
 */

export const CANONICAL_TEST_IDENTITY = {
  accountId: "00000000-0000-4000-8000-000000000001",
  callerId: "00000000-0000-4000-8000-000000000002"
};

export const CANONICAL_INPUT_ONE_ID = "00000000-0000-4000-8000-000000000301";
export const CANONICAL_INPUT_TWO_ID = "00000000-0000-4000-8000-000000000302";

/**
 * @param {Record<string, unknown>} [overrides]
 */
export function richPublicInput(overrides = {}) {
  return {
    caller_item_id: "workflow:nested",
    row_type: { display: "Review", icon: "mail" },
    row_accent_color: null,
    title: "Canonical title",
    subtitle: "Canonical subtitle",
    corner: null,
    summary: "Canonical summary",
    details: null,
    link_buttons: [
      {
        display: "Open source",
        icon: "external-link",
        url: "https://example.com/source"
      },
      {
        display: "Inbox",
        icon: "inbox",
        url: "https://example.com/inbox"
      }
    ],
    card_visual: {
      kind: "progress_ring",
      label: "Progress",
      value: 4,
      display: "4/10",
      unit: "%",
      min_value: 0,
      max_value: 10,
      color: "blue"
    },
    actions: [
      {
        display: "Approve",
        icon: "send",
        value: "approve",
        overflow: false,
        tone: "success",
        style: "solid",
        popup: { kind: "none" }
      },
      {
        display: "Comment",
        icon: "message-square",
        value: "comment",
        overflow: false,
        popup: {
          kind: "free_text",
          label: "Notes",
          placeholder: null,
          default_value: null,
          multiline: true,
          min_length: null,
          max_length: 200
        }
      },
      {
        display: "Pick one",
        icon: "inbox",
        value: "pick_one",
        overflow: true,
        popup: {
          kind: "single_select",
          label: "Choice",
          options: [
            { display: "A", value: "a", icon: "check" },
            { display: "B", value: "b", icon: null }
          ]
        }
      },
      {
        display: "Pick many",
        icon: "archive",
        value: "pick_many",
        overflow: true,
        popup: {
          kind: "multi_select",
          label: "Checks",
          options: [
            { display: "One", value: "one" },
            { display: "Two", value: "two" }
          ]
        }
      },
      {
        display: "Schedule",
        icon: "calendar",
        value: "schedule",
        overflow: true,
        popup: {
          kind: "date_picker",
          label: "When",
          mode: "date",
          placeholder: null,
          display_timezone: "America/New_York",
          min_value: null,
          max_value: null
        }
      },
      {
        display: "Upload",
        icon: "upload",
        value: "upload",
        overflow: true,
        popup: {
          kind: "file_upload",
          label: "File",
          accept_mime_types: null
        }
      }
    ],
    ...overrides
  };
}

/**
 * @param {Record<string, unknown>} [input]
 * @returns {NormalizedInputSubmission}
 */
export function parseValidSubmission(input = richPublicInput()) {
  const parsed = parseInputSubmission(input, { limitProfile: "hosted-paid" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    assert.fail("expected valid input submission");
  }
  return parsed.submission;
}

/**
 * @param {NormalizedInputSubmission} submission
 */
export function canonicalFormsFromSubmission(submission) {
  return canonicalInputForms({
    callerItemId: submission.callerItemId,
    priority: submission.priority,
    rowType: submission.rowType,
    rowAccentColor: submission.rowAccentColor,
    titleHtml: submission.titleHtml,
    subtitleHtml: submission.subtitleHtml,
    cornerHtml: submission.cornerHtml,
    summaryHtml: submission.summaryHtml,
    detailsHtml: submission.detailsHtml,
    linkButtons: submission.linkButtons,
    cardVisual: submission.cardVisual,
    skipDisabled: submission.skipDisabled,
    actions: submission.actions
  });
}

/**
 * @param {string} inputItemId
 * @param {NormalizedInputSubmission} submission
 * @param {Partial<QueryResultRow>} [rootOverrides]
 * @param {{ actionIdPrefix?: string }} [options]
 */
export function storedRowsFromSubmission(
  inputItemId,
  submission,
  rootOverrides = {},
  options = {}
) {
  const actionIdPrefix =
    options.actionIdPrefix ?? "00000000-0000-4000-8000-0000000004";
  return {
    root: {
      input_item_id: inputItemId,
      caller_item_id: submission.callerItemId,
      status: "pending",
      current_revision: 1,
      priority: submission.priority,
      row_type_display: submission.rowType.display,
      row_type_icon: submission.rowType.icon,
      row_accent_color: submission.rowAccentColor,
      title_html: submission.titleHtml,
      subtitle_html: submission.subtitleHtml,
      corner_html: submission.cornerHtml,
      summary_html: submission.summaryHtml,
      details_html: submission.detailsHtml,
      card_visual_kind: submission.cardVisual?.kind ?? null,
      card_visual_payload: submission.cardVisual?.payload ?? {},
      skip_disabled: submission.skipDisabled,
      normalized_content_fingerprint: submission.normalizedContentFingerprint,
      created_at: "2026-06-30T12:00:00.000Z",
      updated_at: "2026-06-30T12:05:00.000Z",
      answered_at: null,
      ...rootOverrides
    },
    links: submission.linkButtons.map((button) => ({
      input_item_id: inputItemId,
      display_order: button.displayOrder,
      display: button.display,
      icon: button.icon,
      url: button.url
    })),
    actions: submission.actions.map((action, index) => ({
      input_item_id: inputItemId,
      input_action_id: `${actionIdPrefix}${String(index).padStart(2, "0")}`,
      display_order: action.displayOrder,
      display: action.display,
      icon: action.icon,
      action_value: action.value,
      overflow: action.overflow,
      action_tone: action.tone,
      action_style: action.style,
      popup_kind: action.popupKind,
      popup_payload: action.popupPayload
    })),
    options: submission.actions.flatMap((action, index) =>
      action.options.map((option) => ({
        input_item_id: inputItemId,
        input_action_id: `${actionIdPrefix}${String(index).padStart(2, "0")}`,
        display_order: option.displayOrder,
        display: option.display,
        option_value: option.value,
        icon: option.icon
      }))
    )
  };
}

/**
 * @param {string} inputItemId
 * @param {string} callerItemId
 * @param {{
 *   fingerprint?: string | null,
 *   actionIdPrefix?: string,
 *   rootOverrides?: Partial<QueryResultRow>,
 *   inputOverrides?: Record<string, unknown>
 * }} [options]
 */
export function canonicalRelationalFixture(
  inputItemId,
  callerItemId,
  options = {}
) {
  const submission = parseValidSubmission(
    options.inputOverrides
      ? { ...options.inputOverrides, caller_item_id: callerItemId }
      : {
          caller_item_id: callerItemId,
          row_type: { display: "Email Draft", icon: "mail" },
          title: "Reply",
          subtitle: "Draft",
          summary: "Approve",
          link_buttons: [],
          actions: [
            {
              display: "Send",
              icon: "send",
              value: "send",
              overflow: false,
              popup: { kind: "none" }
            }
          ]
        }
  );
  const { rawInput } = canonicalFormsFromSubmission(submission);
  const stored = storedRowsFromSubmission(
    inputItemId,
    submission,
    {
      status: "answered",
      created_at: "2026-06-30T11:00:00.000Z",
      updated_at: "2026-06-30T12:00:00.000Z",
      answered_at: "2026-06-30T12:00:00.000Z",
      ...(options.fingerprint
        ? { normalized_content_fingerprint: options.fingerprint }
        : {}),
      ...options.rootOverrides
    },
    { actionIdPrefix: options.actionIdPrefix }
  );
  return {
    rawInput,
    submission,
    roots: [stored.root],
    links: stored.links,
    actions: stored.actions,
    options: stored.options
  };
}
