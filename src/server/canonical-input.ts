import {
  apiTimestamp,
  isJsonRecord,
  type ApiErrorInput,
  type ApiRequestContext
} from "./api-errors.ts";
import type { CallerIdentity } from "./caller-api-auth.ts";
import type {
  ProductTransactionQuery,
  TransactionContextStatement
} from "./database.ts";
import {
  ACTION_STYLES,
  ACTION_TONES,
  CARD_VISUAL_KINDS,
  POPUP_KINDS,
  QUEUE_PRIORITIES,
  canonicalInputForms,
  sha256Hex,
  stableStringify,
  type ActionStyle,
  type ActionTone,
  type CanonicalInputParts,
  type NormalizedCardVisual,
  type NormalizedPopupOption,
  type NormalizedPopupPayload,
  type PopupKind,
  type QueuePriority
} from "./input-schema.ts";
import { publicCanonicalRawInputShapeMatches } from "../shared/public-api-contract.ts";
import { durationSinceMs } from "./logging.ts";
import { reportRuntimeFailure } from "./sentry.ts";

export const CANONICAL_INPUT_INTEGRITY_OPERATION = "canonical_input_integrity";

export class CanonicalInputIntegrityError extends Error {
  readonly inputItemId: string;
  readonly accountId: string;
  readonly callerId: string;

  constructor(input: {
    inputItemId: string;
    accountId: string;
    callerId: string;
  }) {
    super("Canonical input integrity check failed.");
    this.name = "CanonicalInputIntegrityError";
    this.inputItemId = input.inputItemId;
    this.accountId = input.accountId;
    this.callerId = input.callerId;
  }
}

export function isCanonicalInputIntegrityError(
  error: unknown
): error is CanonicalInputIntegrityError {
  return error instanceof CanonicalInputIntegrityError;
}

export function reportCanonicalInputIntegrityFailure(
  error: CanonicalInputIntegrityError,
  context: ApiRequestContext
) {
  return reportRuntimeFailure(error, {
    errorId: context.correlationId,
    request_id: context.requestId,
    surface: "api",
    route: context.route,
    method: context.method,
    status_code: 503,
    duration_ms: durationSinceMs(context.startedAtMs),
    operation: CANONICAL_INPUT_INTEGRITY_OPERATION,
    account_id: error.accountId,
    caller_id: error.callerId,
    input_item_id: error.inputItemId,
    message: "Canonical input integrity check failed."
  });
}

export function canonicalInputIntegrityClientError(options?: {
  errorId?: string;
  reported?: boolean;
}): ApiErrorInput {
  return {
    status: 503,
    code: "temporary_unavailable",
    message: "Canonical input is temporarily unavailable.",
    ...(options?.errorId ? { errorId: options.errorId } : {}),
    ...(options?.reported ? { reported: true } : {})
  };
}

export type CanonicalInputMetadata = {
  caller_item_id: string;
  status: "pending" | "answered";
  revision: number;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
};

export type CanonicalInput = CanonicalInputMetadata & {
  input_item_id: string;
  raw_input: Record<string, unknown>;
};

export type CanonicalInputResult =
  { ok: true; input: CanonicalInput } | { ok: false; error: ApiErrorInput };

export type CanonicalInputRootRow = {
  input_item_id: string;
  caller_item_id: string;
  status: string;
  current_revision: number;
  priority: string;
  row_type_display: string;
  row_type_icon: string;
  row_accent_color: string | null;
  title_html: string;
  subtitle_html: string;
  corner_html: string | null;
  summary_html: string;
  details_html: string | null;
  card_visual_kind: string | null;
  card_visual_payload: unknown;
  skip_disabled: boolean;
  normalized_content_fingerprint: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  answered_at: string | Date | null;
};

export type CanonicalLinkButtonRow = {
  input_item_id: string;
  display_order: number;
  display: string;
  icon: string;
  url: string;
};

export type CanonicalActionRow = {
  input_item_id: string;
  input_action_id: string;
  display_order: number;
  display: string;
  icon: string;
  action_value: string;
  overflow: boolean;
  action_tone: string | null;
  action_style: string | null;
  popup_kind: string;
  popup_payload: unknown;
};

export type CanonicalOptionRow = {
  input_item_id: string;
  input_action_id: string;
  display_order: number;
  display: string;
  option_value: string;
  icon: string | null;
};

export function reconstructCanonicalInput(args: {
  root: CanonicalInputRootRow;
  linkButtons: readonly CanonicalLinkButtonRow[];
  actions: readonly CanonicalActionRow[];
  options: readonly CanonicalOptionRow[];
}): CanonicalInputResult {
  const parts = canonicalPartsFromRows(args);
  if (!parts) {
    return malformedCanonicalInput();
  }

  const { fingerprintForm, rawInput } = canonicalInputForms(parts);
  const fingerprint = sha256Hex(stableStringify(fingerprintForm));
  if (fingerprint !== args.root.normalized_content_fingerprint) {
    return malformedCanonicalInput();
  }
  if (!publicCanonicalRawInputShapeMatches(rawInput)) {
    return malformedCanonicalInput();
  }

  return {
    ok: true,
    input: {
      input_item_id: args.root.input_item_id,
      caller_item_id: args.root.caller_item_id,
      status: args.root.status as "pending" | "answered",
      revision: args.root.current_revision,
      created_at: apiTimestamp(args.root.created_at),
      updated_at: apiTimestamp(args.root.updated_at),
      answered_at:
        args.root.answered_at == null
          ? null
          : apiTimestamp(args.root.answered_at),
      raw_input: rawInput
    }
  };
}

export async function materializeCanonicalInputsByItemId(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  inputItemIds: readonly string[]
): Promise<Map<string, CanonicalInput>> {
  const uniqueIds = uniqueStrings(inputItemIds);
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const roots = await query<CanonicalInputRootRow>(
    canonicalInputRootsStatement(identity, uniqueIds)
  );
  const links = await query<CanonicalLinkButtonRow>(
    canonicalInputLinkButtonsStatement(identity, uniqueIds)
  );
  const actions = await query<CanonicalActionRow>(
    canonicalInputActionsStatement(identity, uniqueIds)
  );
  const options = await query<CanonicalOptionRow>(
    canonicalInputOptionsStatement(identity, uniqueIds)
  );

  const rootsByInputId = new Map(
    roots.rows.map((root) => [root.input_item_id, root])
  );
  const linksByInputId = groupBy(links.rows, (row) => row.input_item_id);
  const actionsByInputId = groupBy(actions.rows, (row) => row.input_item_id);
  const optionsByInputId = groupBy(options.rows, (row) => row.input_item_id);
  const byInputItemId = new Map<string, CanonicalInput>();

  for (const inputItemId of uniqueIds) {
    const root = rootsByInputId.get(inputItemId);
    if (!root) {
      throw new CanonicalInputIntegrityError({
        inputItemId,
        accountId: identity.accountId,
        callerId: identity.callerId
      });
    }
    const reconstructed = reconstructCanonicalInput({
      root,
      linkButtons: linksByInputId.get(inputItemId) ?? [],
      actions: actionsByInputId.get(inputItemId) ?? [],
      options: optionsByInputId.get(inputItemId) ?? []
    });
    if (!reconstructed.ok) {
      throw new CanonicalInputIntegrityError({
        inputItemId,
        accountId: identity.accountId,
        callerId: identity.callerId
      });
    }
    byInputItemId.set(inputItemId, reconstructed.input);
  }

  return byInputItemId;
}

export function canonicalInputRootsStatement(
  identity: CallerIdentity,
  inputItemIds: readonly string[]
): TransactionContextStatement {
  const placeholders = inputItemIds.map((_, index) => `$${index + 3}`);
  return {
    sql: `
      select
        i.input_item_id::text as input_item_id,
        i.caller_item_id,
        i.status,
        i.current_revision,
        i.priority,
        i.row_type_display,
        i.row_type_icon,
        i.row_accent_color,
        i.title_html,
        i.subtitle_html,
        i.corner_html,
        i.summary_html,
        i.details_html,
        i.card_visual_kind,
        i.card_visual_payload,
        i.skip_disabled,
        i.normalized_content_fingerprint,
        i.created_at,
        i.updated_at,
        i.answered_at
      from public.agent_outbox_input_items i
      where i.account_id = $1
        and i.caller_id = $2
        and i.input_item_id in (${placeholders.join(", ")})
    `,
    values: [identity.accountId, identity.callerId, ...inputItemIds]
  };
}

export function canonicalInputLinkButtonsStatement(
  identity: CallerIdentity,
  inputItemIds: readonly string[]
): TransactionContextStatement {
  const placeholders = inputItemIds.map((_, index) => `$${index + 3}`);
  return {
    sql: `
      select
        i.input_item_id::text as input_item_id,
        button.display_order,
        button.display,
        button.icon,
        button.url
      from public.agent_outbox_input_link_buttons button
      join public.agent_outbox_input_items i
        on i.input_item_id = button.input_item_id
      where i.account_id = $1
        and i.caller_id = $2
        and i.input_item_id in (${placeholders.join(", ")})
      order by button.input_item_id, button.display_order, button.input_link_button_id
    `,
    values: [identity.accountId, identity.callerId, ...inputItemIds]
  };
}

export function canonicalInputActionsStatement(
  identity: CallerIdentity,
  inputItemIds: readonly string[]
): TransactionContextStatement {
  const placeholders = inputItemIds.map((_, index) => `$${index + 3}`);
  return {
    sql: `
      select
        i.input_item_id::text as input_item_id,
        action.input_action_id::text as input_action_id,
        action.display_order,
        action.display,
        action.icon,
        action.action_value,
        action.overflow,
        action.action_tone,
        action.action_style,
        action.popup_kind,
        action.popup_payload
      from public.agent_outbox_input_actions action
      join public.agent_outbox_input_items i
        on i.input_item_id = action.input_item_id
      where i.account_id = $1
        and i.caller_id = $2
        and i.input_item_id in (${placeholders.join(", ")})
      order by action.input_item_id, action.display_order, action.input_action_id
    `,
    values: [identity.accountId, identity.callerId, ...inputItemIds]
  };
}

export function canonicalInputOptionsStatement(
  identity: CallerIdentity,
  inputItemIds: readonly string[]
): TransactionContextStatement {
  const placeholders = inputItemIds.map((_, index) => `$${index + 3}`);
  return {
    sql: `
      select
        i.input_item_id::text as input_item_id,
        action.input_action_id::text as input_action_id,
        option.display_order,
        option.display,
        option.option_value,
        option.icon
      from public.agent_outbox_input_action_popup_options option
      join public.agent_outbox_input_actions action
        on action.input_action_id = option.input_action_id
      join public.agent_outbox_input_items i
        on i.input_item_id = action.input_item_id
      where i.account_id = $1
        and i.caller_id = $2
        and i.input_item_id in (${placeholders.join(", ")})
      order by
        action.input_action_id,
        option.display_order,
        option.input_action_popup_option_id
    `,
    values: [identity.accountId, identity.callerId, ...inputItemIds]
  };
}

function canonicalPartsFromRows(args: {
  root: CanonicalInputRootRow;
  linkButtons: readonly CanonicalLinkButtonRow[];
  actions: readonly CanonicalActionRow[];
  options: readonly CanonicalOptionRow[];
}): CanonicalInputParts | null {
  const root = args.root;
  if (
    !nonEmptyString(root.caller_item_id) ||
    !nonEmptyString(root.row_type_display) ||
    !nonEmptyString(root.row_type_icon) ||
    !nonEmptyString(root.title_html) ||
    !nonEmptyString(root.subtitle_html) ||
    !nonEmptyString(root.summary_html) ||
    (root.status !== "pending" && root.status !== "answered") ||
    !QUEUE_PRIORITIES.has(root.priority) ||
    !Number.isSafeInteger(root.current_revision) ||
    root.current_revision < 1 ||
    typeof root.skip_disabled !== "boolean" ||
    (root.row_accent_color != null && !nonEmptyString(root.row_accent_color)) ||
    (root.corner_html != null && typeof root.corner_html !== "string") ||
    (root.details_html != null && typeof root.details_html !== "string")
  ) {
    return null;
  }

  const cardVisual = cardVisualFromStored(
    root.card_visual_kind,
    root.card_visual_payload
  );
  if (cardVisual === undefined) {
    return null;
  }

  const optionsByActionId = groupBy(
    args.options,
    (option) => option.input_action_id
  );
  const actions: CanonicalInputParts["actions"][number][] = [];
  for (const action of args.actions) {
    const reconstructed = actionFromStored(
      action,
      optionsByActionId.get(action.input_action_id) ?? []
    );
    if (!reconstructed) {
      return null;
    }
    actions.push(reconstructed);
  }

  const linkButtons: CanonicalInputParts["linkButtons"][number][] = [];
  for (const button of args.linkButtons) {
    if (
      !nonEmptyString(button.display) ||
      !nonEmptyString(button.icon) ||
      !nonEmptyString(button.url)
    ) {
      return null;
    }
    linkButtons.push({
      display: button.display,
      icon: button.icon,
      url: button.url
    });
  }

  return {
    callerItemId: root.caller_item_id,
    priority: root.priority as QueuePriority,
    rowType: {
      display: root.row_type_display,
      icon: root.row_type_icon
    },
    rowAccentColor: root.row_accent_color,
    titleHtml: root.title_html,
    subtitleHtml: root.subtitle_html,
    cornerHtml: root.corner_html,
    summaryHtml: root.summary_html,
    detailsHtml: root.details_html,
    linkButtons,
    cardVisual,
    skipDisabled: root.skip_disabled,
    actions
  };
}

function actionFromStored(
  action: CanonicalActionRow,
  optionRows: readonly CanonicalOptionRow[]
): CanonicalInputParts["actions"][number] | null {
  if (
    !nonEmptyString(action.display) ||
    !nonEmptyString(action.icon) ||
    !nonEmptyString(action.action_value) ||
    typeof action.overflow !== "boolean" ||
    !POPUP_KINDS.has(action.popup_kind) ||
    !isJsonRecord(action.popup_payload)
  ) {
    return null;
  }
  if (
    (action.action_tone == null) !== (action.action_style == null) ||
    (action.action_tone != null && !ACTION_TONES.has(action.action_tone)) ||
    (action.action_style != null && !ACTION_STYLES.has(action.action_style))
  ) {
    return null;
  }

  const options: NormalizedPopupOption[] = [];
  for (const option of optionRows) {
    if (
      !nonEmptyString(option.display) ||
      !nonEmptyString(option.option_value) ||
      !Number.isSafeInteger(option.display_order) ||
      option.display_order < 0 ||
      (option.icon != null && !nonEmptyString(option.icon))
    ) {
      return null;
    }
    options.push({
      displayOrder: option.display_order,
      display: option.display,
      value: option.option_value,
      icon: option.icon
    });
  }

  return {
    display: action.display,
    icon: action.icon,
    value: action.action_value,
    overflow: action.overflow,
    tone: action.action_tone as ActionTone | null,
    style: action.action_style as ActionStyle | null,
    popupKind: action.popup_kind as PopupKind,
    popupPayload: action.popup_payload as NormalizedPopupPayload,
    options
  };
}

function cardVisualFromStored(
  kind: string | null,
  payload: unknown
): NormalizedCardVisual | null | undefined {
  if (kind == null) {
    return null;
  }
  if (!CARD_VISUAL_KINDS.has(kind) || !isJsonRecord(payload)) {
    return undefined;
  }
  if (kind === "numeric_bar") {
    return {
      kind: "numeric_bar",
      payload: payload as Extract<
        NormalizedCardVisual,
        { kind: "numeric_bar" }
      >["payload"]
    };
  }
  if (kind === "pill") {
    return {
      kind: "pill",
      payload: payload as Extract<
        NormalizedCardVisual,
        { kind: "pill" }
      >["payload"]
    };
  }
  return {
    kind: "progress_ring",
    payload: payload as Extract<
      NormalizedCardVisual,
      { kind: "progress_ring" }
    >["payload"]
  };
}

function malformedCanonicalInput(): { ok: false; error: ApiErrorInput } {
  return {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message: "Canonical input is temporarily unavailable."
    }
  };
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(key(row)) ?? [];
    list.push(row);
    grouped.set(key(row), list);
  }
  return grouped;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
