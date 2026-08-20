import type { AuthorizedHumanAccountContext } from "./authorization.ts";
import type { TransactionContextStatement } from "./database.ts";
import type {
  ActionStyle,
  ActionTone,
  NormalizedCardVisual,
  NormalizedDatePickerPopupPayload,
  NormalizedFileUploadPopupPayload,
  NormalizedFreeTextPopupPayload,
  NormalizedMultiSelectPopupPayload,
  NormalizedSelectPopupPayload,
  PopupKind,
  QueuePriority
} from "./input-schema.ts";
import {
  accountStatusInTransaction,
  type AccountStatusData,
  type StatusResult
} from "./status.ts";
import type { ProductTransactionQuery } from "./database.ts";

export type HumanReviewStatus = "pending" | "answered";

export type HumanReviewListOptions = {
  status?: "all" | HumanReviewStatus;
  search?: string | null;
  sort?: "priority" | "updated_at";
  limit?: number;
  offset?: number;
};

export type HumanReviewPage = {
  rows: HumanReviewListRow[];
  hasNext: boolean;
};

export type HumanReviewCallerAffordance = {
  callerId: string;
  displayName: string;
  slug: string | null;
  revoked: boolean;
};

export type HumanReviewOutputState = {
  outputResultId: string;
  actionValue: string;
  actionDisplay: string;
  answeredAt: string;
  firstReadAt: string | null;
  readCount: number;
  undoEligible: boolean;
};

export type HumanReviewBulkAction = {
  displayOrder: number;
  display: string;
  icon: string;
  value: string;
  tone?: ActionTone | null;
  style?: ActionStyle | null;
  popupKind: PopupKind;
  overflow: boolean;
};

export type HumanReviewListRow = {
  inputItemId: string;
  callerItemId: string;
  status: HumanReviewStatus;
  priority: QueuePriority;
  currentRevision: number;
  rowType: { display: string; icon: string };
  rowAccentColor: string | null;
  titleHtml: string;
  subtitleHtml: string;
  cornerHtml: string | null;
  summaryHtml: string;
  cardVisual: NormalizedCardVisual | null;
  skipDisabled: boolean;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  caller: HumanReviewCallerAffordance;
  output: HumanReviewOutputState | null;
  bulkActions: HumanReviewBulkAction[];
  linkButtons?: HumanReviewLinkButton[];
  hasOverflowActions?: boolean;
};

export type HumanReviewLinkButton = {
  displayOrder: number;
  display: string;
  icon: string;
  url: string;
};

type HumanReviewActionBase = {
  displayOrder: number;
  display: string;
  icon: string;
  value: string;
  overflow: boolean;
  tone?: ActionTone | null;
  style?: ActionStyle | null;
  answerable: boolean;
  options: HumanReviewActionOption[];
};

export type HumanReviewAction = HumanReviewActionBase &
  (
    | { popupKind: "none"; popupPayload: Record<string, never> }
    | { popupKind: "free_text"; popupPayload: NormalizedFreeTextPopupPayload }
    | { popupKind: "single_select"; popupPayload: NormalizedSelectPopupPayload }
    | {
        popupKind: "multi_select";
        popupPayload: NormalizedMultiSelectPopupPayload;
      }
    | {
        popupKind: "date_picker";
        popupPayload: NormalizedDatePickerPopupPayload;
      }
    | {
        popupKind: "file_upload";
        popupPayload: NormalizedFileUploadPopupPayload;
      }
  );

export type HumanReviewActionOption = {
  displayOrder: number;
  display: string;
  value: string;
  icon: string | null;
};

export type HumanReviewDetail = HumanReviewListRow & {
  detailsHtml: string | null;
  linkButtons: HumanReviewLinkButton[];
  actions: HumanReviewAction[];
};

type HumanReviewRow = {
  input_item_id: string;
  caller_item_id: string;
  status: HumanReviewStatus;
  priority: QueuePriority;
  current_revision: number;
  row_type_display: string;
  row_type_icon: string;
  row_accent_color: string | null;
  title_html: string;
  subtitle_html: string;
  corner_html: string | null;
  summary_html: string;
  details_html?: string | null;
  card_visual_kind: string | null;
  card_visual_payload: unknown;
  skip_disabled: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  answered_at: string | Date | null;
  caller_id: string;
  caller_display_name: string;
  caller_slug: string | null;
  caller_revoked_at: string | Date | null;
  output_result_id: string | null;
  output_action_value: string | null;
  output_action_display: string | null;
  output_answered_at: string | Date | null;
  output_first_read_at: string | Date | null;
  output_read_count: number | null;
  bulk_actions: HumanReviewBulkAction[];
  link_buttons: HumanReviewLinkButton[];
};

type LinkButtonRow = {
  display_order: number;
  display: string;
  icon: string;
  url: string;
};

type ActionRow = {
  input_action_id: string;
  display_order: number;
  display: string;
  icon: string;
  action_value: string;
  overflow: boolean;
  action_tone: ActionTone | null;
  action_style: ActionStyle | null;
  popup_kind: string;
  popup_payload: unknown;
};

type ActionOptionRow = {
  input_action_id: string;
  display_order: number;
  display: string;
  option_value: string;
  icon: string | null;
};

const DEFAULT_REVIEW_LIST_LIMIT = 50;
export const REVIEW_PAGE_SIZE = 100;
const MAX_REVIEW_LIST_LIMIT = REVIEW_PAGE_SIZE;
const REVIEW_PAGE_QUERY_LIMIT = MAX_REVIEW_LIST_LIMIT + 1;

export async function humanReviewListInTransaction(
  query: ProductTransactionQuery,
  context: AuthorizedHumanAccountContext,
  options: HumanReviewListOptions = {}
): Promise<HumanReviewListRow[]> {
  const rows = await query<HumanReviewRow>(
    humanReviewListStatement(context, options)
  );
  return rows.rows.map(reviewListRowFromDatabase);
}

export async function humanReviewPageInTransaction(
  query: ProductTransactionQuery,
  context: AuthorizedHumanAccountContext,
  options: Omit<HumanReviewListOptions, "limit"> = {}
): Promise<HumanReviewPage> {
  const result = await query<HumanReviewRow>(
    humanReviewListStatementWithLimit(context, options, REVIEW_PAGE_QUERY_LIMIT)
  );
  return {
    rows: result.rows
      .slice(0, MAX_REVIEW_LIST_LIMIT)
      .map(reviewListRowFromDatabase),
    hasNext: result.rows.length > MAX_REVIEW_LIST_LIMIT
  };
}

export async function humanReviewDetailInTransaction(
  query: ProductTransactionQuery,
  context: AuthorizedHumanAccountContext,
  inputItemId: string
): Promise<HumanReviewDetail | null> {
  const input = await query<HumanReviewRow>(
    humanReviewDetailStatement(context, inputItemId)
  );
  const row = input.rows[0];
  if (!row) {
    return null;
  }

  const links = await query<LinkButtonRow>(
    humanReviewLinkButtonsStatement(inputItemId)
  );
  const actions = await query<ActionRow>(
    humanReviewActionsStatement(inputItemId)
  );
  const options = await query<ActionOptionRow>(
    humanReviewActionOptionsStatement(inputItemId)
  );
  const optionsByActionId = new Map<string, HumanReviewActionOption[]>();
  for (const option of options.rows) {
    const actionOptions = optionsByActionId.get(option.input_action_id) ?? [];
    actionOptions.push({
      displayOrder: option.display_order,
      display: option.display,
      value: option.option_value,
      icon: option.icon
    });
    optionsByActionId.set(option.input_action_id, actionOptions);
  }

  const accountStatus = await accountStatusInTransaction(query, {
    accountId: context.accountId,
    callerId: ""
  });
  const fileUploadAnswerable =
    accountStatus.ok && accountStatus.data.file_upload_enabled;
  const base = reviewListRowFromDatabase(row);
  return {
    ...base,
    detailsHtml: row.details_html ?? null,
    linkButtons: links.rows.map((link) => ({
      displayOrder: link.display_order,
      display: link.display,
      icon: link.icon,
      url: link.url
    })),
    actions: actions.rows.map((action) =>
      reviewActionFromDatabase(
        action,
        optionsByActionId.get(action.input_action_id) ?? [],
        row.status === "pending" &&
          (action.popup_kind !== "file_upload" || fileUploadAnswerable)
      )
    )
  };
}

export async function humanReviewAccountBannerInTransaction(
  query: ProductTransactionQuery,
  context: AuthorizedHumanAccountContext
): Promise<StatusResult<AccountStatusData>> {
  return accountStatusInTransaction(query, {
    accountId: context.accountId,
    callerId: ""
  });
}

export function humanReviewListStatement(
  context: AuthorizedHumanAccountContext,
  options: HumanReviewListOptions = {}
): TransactionContextStatement {
  return humanReviewListStatementWithLimit(
    context,
    options,
    boundedLimit(options.limit)
  );
}

function humanReviewListStatementWithLimit(
  context: AuthorizedHumanAccountContext,
  options: HumanReviewListOptions,
  limit: number
): TransactionContextStatement {
  const values: (string | number)[] = [context.accountId];
  const filters = ["i.account_id = $1"];
  const status =
    options.status && options.status !== "all" ? options.status : null;
  if (status) {
    values.push(status);
    filters.push(`i.status = $${values.length}`);
  }

  const search = options.search?.trim();
  if (search) {
    const escapedSearch = search
      .replaceAll("!", "!!")
      .replaceAll("%", "!%")
      .replaceAll("_", "!_");
    values.push(`%${escapedSearch}%`);
    // Search visible text: strip markup from the HTML columns so allowed
    // inline tags neither match tag names nor split matching phrases.
    filters.push(`(
      regexp_replace(i.title_html, '<[^>]*>', ' ', 'g') ilike $${values.length} escape '!'
      or regexp_replace(i.subtitle_html, '<[^>]*>', ' ', 'g') ilike $${values.length} escape '!'
      or regexp_replace(i.summary_html, '<[^>]*>', ' ', 'g') ilike $${values.length} escape '!'
      or i.caller_item_id ilike $${values.length} escape '!'
      or i.row_type_display ilike $${values.length} escape '!'
      or c.display_name ilike $${values.length} escape '!'
    )`);
  }

  values.push(limit);
  const limitParameter = values.length;
  values.push(options.offset ?? 0);

  return {
    sql: `
      ${reviewRowSelect()}
      where ${filters.join("\n        and ")}
      ${reviewRowOrderBy(options.sort)}
      limit $${limitParameter}
      offset $${values.length}
    `,
    values
  };
}

export function humanReviewDetailStatement(
  context: AuthorizedHumanAccountContext,
  inputItemId: string
): TransactionContextStatement {
  return {
    sql: `
      ${reviewRowSelect({ includeDetails: true })}
      where i.account_id = $1
        and i.input_item_id::text = $2
    `,
    values: [context.accountId, inputItemId]
  };
}

export function humanReviewLinkButtonsStatement(
  inputItemId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        display_order,
        display,
        icon,
        url
      from public.agent_outbox_input_link_buttons
      where input_item_id::text = $1
      order by display_order, input_link_button_id
    `,
    values: [inputItemId]
  };
}

export function humanReviewActionsStatement(
  inputItemId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        input_action_id::text as input_action_id,
        display_order,
        display,
        icon,
        action_value,
        overflow,
        action_tone,
        action_style,
        popup_kind,
        popup_payload
      from public.agent_outbox_input_actions
      where input_item_id::text = $1
      order by display_order, input_action_id
    `,
    values: [inputItemId]
  };
}

export function humanReviewActionOptionsStatement(
  inputItemId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        option.input_action_id::text as input_action_id,
        option.display_order,
        option.display,
        option.option_value,
        option.icon
      from public.agent_outbox_input_action_popup_options option
      join public.agent_outbox_input_actions action
        on action.input_action_id = option.input_action_id
      where action.input_item_id::text = $1
      order by option.input_action_id, option.display_order, option.input_action_popup_option_id
    `,
    values: [inputItemId]
  };
}

function reviewRowSelect(options: { includeDetails?: boolean } = {}) {
  const detailsColumn = options.includeDetails ? "i.details_html," : "";

  return `
    select
      i.input_item_id::text as input_item_id,
      i.caller_item_id,
      i.status,
      i.priority,
      i.current_revision,
      i.row_type_display,
      i.row_type_icon,
      i.row_accent_color,
      i.title_html,
      i.subtitle_html,
      i.corner_html,
      i.summary_html,
      ${detailsColumn}
      i.card_visual_kind,
      i.card_visual_payload,
      i.skip_disabled,
      i.created_at,
      i.updated_at,
      i.answered_at,
      c.caller_id::text as caller_id,
      c.display_name as caller_display_name,
      c.caller_slug,
      c.revoked_at as caller_revoked_at,
      o.output_result_id::text as output_result_id,
      o.action_value as output_action_value,
      answered_action.display as output_action_display,
      o.answered_at as output_answered_at,
      o.first_read_at as output_first_read_at,
      o.read_count as output_read_count,
      bulk.bulk_actions,
      links.link_buttons
    from public.agent_outbox_input_items i
    join public.agent_outbox_callers c
      on c.account_id = i.account_id
     and c.caller_id = i.caller_id
    left join public.agent_outbox_output_results o
      on o.account_id = i.account_id
     and o.caller_id = i.caller_id
     and o.input_item_id = i.input_item_id
    left join public.agent_outbox_input_actions answered_action
      on answered_action.input_item_id = i.input_item_id
     and answered_action.action_value = o.action_value
    left join lateral (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'displayOrder', action.display_order,
            'display', action.display,
            'icon', action.icon,
            'value', action.action_value,
            'tone', action.action_tone,
            'style', action.action_style,
            'popupKind', action.popup_kind,
            'overflow', action.overflow
          )
          order by action.display_order, action.input_action_id
        ),
        '[]'::jsonb
      ) as bulk_actions
      from public.agent_outbox_input_actions action
      where action.input_item_id = i.input_item_id
    ) bulk on true
    left join lateral (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'displayOrder', link.display_order,
            'display', link.display,
            'icon', link.icon,
            'url', link.url
          )
          order by link.display_order, link.input_link_button_id
        ),
        '[]'::jsonb
      ) as link_buttons
      from public.agent_outbox_input_link_buttons link
      where link.input_item_id = i.input_item_id
    ) links on true
  `;
}

function reviewRowOrderBy(sort: HumanReviewListOptions["sort"]) {
  if (sort === "priority") {
    return `
      order by
        case i.priority
          when 'urgent' then 0
          when 'high' then 1
          when 'normal' then 2
          else 3
        end,
        i.updated_at desc,
        i.input_item_id
    `;
  }

  return "order by i.updated_at desc, i.input_item_id";
}

function reviewListRowFromDatabase(row: HumanReviewRow): HumanReviewListRow {
  return {
    inputItemId: row.input_item_id,
    callerItemId: row.caller_item_id,
    status: row.status,
    priority: row.priority,
    currentRevision: row.current_revision,
    rowType: {
      display: row.row_type_display,
      icon: row.row_type_icon
    },
    rowAccentColor: row.row_accent_color,
    titleHtml: row.title_html,
    subtitleHtml: row.subtitle_html,
    cornerHtml: row.corner_html,
    summaryHtml: row.summary_html,
    cardVisual: cardVisualFromDatabase(
      row.card_visual_kind,
      row.card_visual_payload
    ),
    skipDisabled: row.skip_disabled,
    createdAt: timestampValue(row.created_at),
    updatedAt: timestampValue(row.updated_at),
    answeredAt: nullableTimestampValue(row.answered_at),
    caller: {
      callerId: row.caller_id,
      displayName: row.caller_display_name,
      slug: row.caller_slug,
      revoked: row.caller_revoked_at != null
    },
    bulkActions: (row.bulk_actions ?? []).map((action) => ({
      ...action,
      popupKind: action.popupKind ?? "none",
      overflow: action.overflow ?? false
    })),
    linkButtons: row.link_buttons ?? [],
    hasOverflowActions: (row.bulk_actions ?? []).some(
      (action) => action.overflow
    ),
    output:
      row.output_result_id && row.output_action_value && row.output_answered_at
        ? {
            outputResultId: row.output_result_id,
            actionValue: row.output_action_value,
            actionDisplay: row.output_action_display ?? "Previous response",
            answeredAt: timestampValue(row.output_answered_at),
            firstReadAt: nullableTimestampValue(row.output_first_read_at),
            readCount: row.output_read_count ?? 0,
            undoEligible: row.output_first_read_at == null
          }
        : null
  };
}

function boundedLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1) {
    return DEFAULT_REVIEW_LIST_LIMIT;
  }
  return Math.min(limit, MAX_REVIEW_LIST_LIMIT);
}

function reviewActionFromDatabase(
  action: ActionRow,
  options: HumanReviewActionOption[],
  answerable: boolean
): HumanReviewAction {
  const base: HumanReviewActionBase = {
    displayOrder: action.display_order,
    display: action.display,
    icon: action.icon,
    value: action.action_value,
    overflow: action.overflow,
    ...(action.action_tone && action.action_style
      ? { tone: action.action_tone, style: action.action_style }
      : {}),
    answerable,
    options
  };
  const payload = recordValue(action.popup_payload);
  switch (action.popup_kind) {
    case "none":
      return { ...base, popupKind: "none", popupPayload: {} };
    case "free_text":
      return {
        ...base,
        popupKind: "free_text",
        popupPayload: {
          label: stringValue(payload.label),
          placeholder: nullableStringValue(payload.placeholder),
          default_value: nullableStringValue(payload.default_value),
          multiline: payload.multiline === true,
          min_length: nullableNumberValue(payload.min_length),
          max_length: nullableNumberValue(payload.max_length)
        }
      };
    case "single_select":
      return {
        ...base,
        popupKind: "single_select",
        popupPayload: { label: stringValue(payload.label) }
      };
    case "multi_select":
      return {
        ...base,
        popupKind: "multi_select",
        popupPayload: {
          label: stringValue(payload.label),
          min_selected: numberValue(payload.min_selected),
          max_selected: numberValue(payload.max_selected)
        }
      };
    case "date_picker":
      return {
        ...base,
        popupKind: "date_picker",
        popupPayload: {
          label: stringValue(payload.label),
          mode: payload.mode === "datetime" ? "datetime" : "date",
          placeholder: nullableStringValue(payload.placeholder),
          display_timezone: nullableStringValue(payload.display_timezone),
          min_value: nullableStringValue(payload.min_value),
          max_value: nullableStringValue(payload.max_value)
        }
      };
    case "file_upload":
      return {
        ...base,
        popupKind: "file_upload",
        popupPayload: {
          label: stringValue(payload.label),
          accept_mime_types: Array.isArray(payload.accept_mime_types)
            ? payload.accept_mime_types.filter(
                (value): value is string => typeof value === "string"
              )
            : null
        }
      };
    default:
      throw new Error(
        `Unsupported persisted popup_kind: ${JSON.stringify(action.popup_kind)}`
      );
  }
}

function cardVisualFromDatabase(
  kind: string | null,
  rawPayload: unknown
): NormalizedCardVisual | null {
  const payload = recordValue(rawPayload);
  if (kind === "numeric_bar" || kind === "progress_ring") {
    const numeric = {
      label: stringValue(payload.label),
      value: numberValue(payload.value),
      display: stringValue(payload.display),
      unit: nullableStringValue(payload.unit),
      min_value: numberValue(payload.min_value),
      max_value: numberValue(payload.max_value)
    };
    return kind === "numeric_bar"
      ? { kind, payload: numeric }
      : {
          kind,
          payload: {
            ...numeric,
            color: nullableStringValue(payload.color)
          }
        };
  }
  if (kind === "pill") {
    return {
      kind,
      payload: {
        text: stringValue(payload.text),
        icon: nullableStringValue(payload.icon),
        color: stringValue(payload.color)
      }
    };
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableTimestampValue(value: string | Date | null): string | null {
  if (value == null) {
    return null;
  }
  return timestampValue(value);
}

function timestampValue(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
