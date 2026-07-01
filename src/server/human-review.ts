import type { AuthorizedHumanAccountContext } from "./authorization.ts";
import type { TransactionContextStatement } from "./database.ts";
import type { JsonValue } from "./human-answer.ts";
import type { PopupKind, QueuePriority } from "./input-schema.ts";
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
  cardVisual: { kind: string; payload: JsonValue } | null;
  skipDisabled: boolean;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  caller: HumanReviewCallerAffordance;
  output: HumanReviewOutputState | null;
  bulkActions: HumanReviewBulkAction[];
};

export type HumanReviewLinkButton = {
  displayOrder: number;
  display: string;
  icon: string;
  url: string;
};

export type HumanReviewAction = {
  displayOrder: number;
  display: string;
  icon: string;
  value: string;
  overflow: boolean;
  popupKind: PopupKind;
  popupPayload: JsonValue;
  answerable: boolean;
  options: HumanReviewActionOption[];
};

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
  output_answered_at: string | Date | null;
  output_first_read_at: string | Date | null;
  output_read_count: number | null;
  bulk_actions: HumanReviewBulkAction[];
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
  popup_kind: PopupKind;
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
const MAX_REVIEW_LIST_LIMIT = 100;

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
    actions: actions.rows.map((action) => ({
      displayOrder: action.display_order,
      display: action.display,
      icon: action.icon,
      value: action.action_value,
      overflow: action.overflow,
      popupKind: action.popup_kind,
      popupPayload: jsonValue(action.popup_payload),
      answerable:
        row.status === "pending" && action.popup_kind !== "file_upload",
      options: optionsByActionId.get(action.input_action_id) ?? []
    }))
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
    values.push(`%${search}%`);
    filters.push(`(
      i.title_html ilike $${values.length}
      or i.subtitle_html ilike $${values.length}
      or i.summary_html ilike $${values.length}
      or i.caller_item_id ilike $${values.length}
      or c.display_name ilike $${values.length}
    )`);
  }

  const limit = boundedLimit(options.limit);
  values.push(limit);

  return {
    sql: `
      ${reviewRowSelect()}
      where ${filters.join("\n        and ")}
      ${reviewRowOrderBy(options.sort)}
      limit $${values.length}
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
      o.answered_at as output_answered_at,
      o.first_read_at as output_first_read_at,
      o.read_count as output_read_count,
      bulk.bulk_actions
    from public.agent_outbox_input_items i
    join public.agent_outbox_callers c
      on c.account_id = i.account_id
     and c.caller_id = i.caller_id
    left join public.agent_outbox_output_results o
      on o.account_id = i.account_id
     and o.caller_id = i.caller_id
     and o.input_item_id = i.input_item_id
    left join lateral (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'displayOrder', action.display_order,
            'display', action.display,
            'icon', action.icon,
            'value', action.action_value
          )
          order by action.display_order, action.input_action_id
        ),
        '[]'::jsonb
      ) as bulk_actions
      from public.agent_outbox_input_actions action
      where action.input_item_id = i.input_item_id
        and action.popup_kind = 'none'
    ) bulk on true
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
    cardVisual: row.card_visual_kind
      ? {
          kind: row.card_visual_kind,
          payload: jsonValue(row.card_visual_payload)
        }
      : null,
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
    bulkActions: row.bulk_actions,
    output:
      row.output_result_id && row.output_action_value && row.output_answered_at
        ? {
            outputResultId: row.output_result_id,
            actionValue: row.output_action_value,
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

function jsonValue(value: unknown): JsonValue {
  return value == null ? {} : (value as JsonValue);
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
