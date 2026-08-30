import Type, { type TSchema } from "typebox";
import Value from "typebox/value";

import type { ApiErrorCode } from "./api-error-contract.ts";
import {
  SUPPORTED_ACTION_STYLES,
  SUPPORTED_ACTION_TONES,
  SUPPORTED_COLORS,
  SUPPORTED_LUCIDE_ICON_NAMES
} from "./input-schema-rules.ts";
import { SYSTEM_CONTRACT } from "./system-contract.ts";

const protocolValuePattern = "^[A-Za-z0-9._:-]{1,128}$";
const hexDigestPattern = "^[a-f0-9]{64}$";

export const PUBLIC_CALLER_API_ERRORS = [
  {
    code: "invalid_request",
    status: 400,
    meaning: "The request shape, query, method, or headers are invalid.",
    recovery: "Correct the request before retrying."
  },
  {
    code: "invalid_json",
    status: 400,
    meaning: "The request body is not valid JSON.",
    recovery: "Serialize a valid JSON body before retrying."
  },
  {
    code: "request_too_large",
    status: 413,
    meaning: "The JSON request body exceeds its byte limit.",
    recovery: "Reduce the request below the documented limit."
  },
  {
    code: "validation_failed",
    status: 422,
    meaning: "One or more fields fail structural or semantic validation.",
    recovery: "Use error.fields to correct each rejected path."
  },
  {
    code: "unsupported_icon",
    status: 422,
    meaning: "An icon is not in the supported Lucide allowlist.",
    recovery: "Choose a value from the generated icon enum."
  },
  {
    code: "unsafe_html",
    status: 422,
    meaning: "Display HTML contains unsafe markup, attributes, or URLs.",
    recovery: "Remove active or unsupported markup and retry."
  },
  {
    code: "unsafe_color",
    status: 422,
    meaning: "A submitted color is not in the supported product palette.",
    recovery: "Choose a value from the generated color enum."
  },
  {
    code: "upgrade_required",
    status: 402,
    meaning: "The caller requested a capability unavailable on its tier.",
    recovery: "Follow error.upgrade or remove the gated capability."
  },
  {
    code: "retention_limit_exceeded",
    status: 429,
    meaning:
      "Retention state requires expired or excess live work to be removed.",
    recovery:
      "Read, acknowledge, or delete live work as indicated by limit metadata."
  },
  {
    code: "billing_grace_expired",
    status: 402,
    meaning: "Billing grace ended and current tier limits now apply.",
    recovery: "Restore billing or reduce usage to the current tier."
  },
  {
    code: "authentication_required",
    status: 401,
    meaning: "No usable bearer credential was supplied.",
    recovery: "Send the connected caller credential as a bearer token."
  },
  {
    code: "invalid_caller_credentials",
    status: 401,
    meaning: "The caller credential is invalid or no longer usable.",
    recovery:
      "Reconnect or rotate the caller; lifecycle detail is intentionally hidden."
  },
  {
    code: "not_found",
    status: 404,
    meaning: "The live resource is absent or unavailable to this caller.",
    recovery:
      "Stop retrying the id unless caller state proves it should still be live."
  },
  {
    code: "pending_content_conflict",
    status: 409,
    meaning:
      "A pending caller_item_id already has different normalized content.",
    recovery: "Use input/replace when the pending request truly changed."
  },
  {
    code: "answered_unacknowledged",
    status: 409,
    meaning: "The item is answered and its output is still unacknowledged.",
    recovery: "Read and durably handle the output, then acknowledge it."
  },
  {
    code: "input_not_pending",
    status: 409,
    meaning: "Replace or delete targeted an item that is no longer pending.",
    recovery:
      "Stop the pending-item operation and reconcile current output state."
  },
  {
    code: "rate_limit_exceeded",
    status: 429,
    meaning: "A fixed-window or burst limit blocked the request.",
    recovery: "Honor Retry-After and retry with backoff and jitter."
  },
  {
    code: "quota_limit_exceeded",
    status: 429,
    meaning: "An account request or submission quota blocked the operation.",
    recovery: "Inspect error.limit and wait for reset or reduce usage."
  },
  {
    code: "storage_limit_exceeded",
    status: 429,
    meaning: "A queue or stored-byte limit blocked storage-producing work.",
    recovery:
      "Delete pending work or acknowledge handled output to free storage."
  },
  {
    code: "temporary_unavailable",
    status: 503,
    meaning: "A transient dependency or runtime failure blocked the operation.",
    recovery:
      "Retry safe operations with bounded exponential backoff and jitter."
  },
  {
    code: "internal_error",
    status: 500,
    meaning: "An unexpected server error occurred.",
    recovery:
      "Retry only when safe and retain request, correlation, and error ids."
  }
] as const satisfies readonly Readonly<{
  code: ApiErrorCode;
  status: number;
  meaning: string;
  recovery: string;
}>[];

const publicCallerApiErrorCodes = PUBLIC_CALLER_API_ERRORS.map(
  ({ code }) => code
);

const nullable = <TSchemaValue extends TSchema>(schema: TSchemaValue) =>
  Type.Union([schema, Type.Null()]);

const openObject = <TProperties extends Parameters<typeof Type.Object>[0]>(
  properties: TProperties,
  options: Parameters<typeof Type.Object>[1] = {}
) => Type.Object(properties, { ...options, additionalProperties: true });

const closedObject = <TProperties extends Parameters<typeof Type.Object>[0]>(
  properties: TProperties,
  options: Parameters<typeof Type.Object>[1] = {}
) => Type.Object(properties, { ...options, additionalProperties: false });

export const ProtocolValueSchema = Type.String({
  pattern: protocolValuePattern,
  description:
    "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
});

export const IconSchema = Type.String({
  enum: [...SUPPORTED_LUCIDE_ICON_NAMES],
  description:
    "A supported Lucide icon name. Arbitrary SVG and HTML are rejected."
});

export const PopupOptionSchema = openObject({
  display: Type.String({ minLength: 1 }),
  value: ProtocolValueSchema,
  icon: Type.Optional(nullable(IconSchema))
});

const NonePopupSchema = openObject({ kind: Type.Literal("none") });

const FreeTextPopupSchema = openObject({
  kind: Type.Literal("free_text"),
  label: Type.String({ minLength: 1 }),
  placeholder: Type.Optional(nullable(Type.String())),
  default_value: Type.Optional(nullable(Type.String())),
  multiline: Type.Boolean(),
  min_length: Type.Optional(nullable(Type.Integer({ minimum: 0 }))),
  max_length: Type.Optional(nullable(Type.Integer({ minimum: 1 })))
});

const SingleSelectPopupSchema = openObject({
  kind: Type.Literal("single_select"),
  label: Type.String({ minLength: 1 }),
  options: Type.Array(PopupOptionSchema, { minItems: 1, maxItems: 64 })
});

const MultiSelectPopupSchema = openObject({
  kind: Type.Literal("multi_select"),
  label: Type.String({ minLength: 1 }),
  options: Type.Array(PopupOptionSchema, { minItems: 1, maxItems: 64 }),
  min_selected: Type.Optional(nullable(Type.Integer({ minimum: 0 }))),
  max_selected: Type.Optional(nullable(Type.Integer({ minimum: 0 })))
});

const DatePickerPopupSchema = openObject({
  kind: Type.Literal("date_picker"),
  label: Type.String({ minLength: 1 }),
  mode: Type.Union([Type.Literal("date"), Type.Literal("datetime")]),
  placeholder: Type.Optional(nullable(Type.String())),
  display_timezone: Type.Optional(nullable(Type.String({ minLength: 1 }))),
  min_value: Type.Optional(nullable(Type.String({ minLength: 1 }))),
  max_value: Type.Optional(nullable(Type.String({ minLength: 1 })))
});

const FileUploadPopupSchema = openObject({
  kind: Type.Literal("file_upload"),
  label: Type.String({ minLength: 1 }),
  accept_mime_types: Type.Optional(
    nullable(Type.Array(Type.String({ minLength: 3 }), { minItems: 1 }))
  )
});

export const ActionPopupSchema = Type.Union(
  [
    NonePopupSchema,
    FreeTextPopupSchema,
    SingleSelectPopupSchema,
    MultiSelectPopupSchema,
    DatePickerPopupSchema,
    FileUploadPopupSchema
  ],
  {
    discriminator: { propertyName: "kind" },
    description:
      "The interaction shown after a human selects this action. The response uses the same kind."
  }
);

export const InputActionSchema = openObject(
  {
    display: Type.String({ minLength: 1 }),
    icon: IconSchema,
    value: ProtocolValueSchema,
    overflow: Type.Boolean(),
    tone: Type.Optional(
      Type.String({
        enum: [...SUPPORTED_ACTION_TONES],
        description:
          "A fixed semantic color token. Supply tone and style together, or omit both for the legacy placement-based appearance."
      })
    ),
    style: Type.Optional(
      Type.String({
        enum: [...SUPPORTED_ACTION_STYLES],
        description:
          "A fixed button treatment. Supply tone and style together, or omit both for the legacy placement-based appearance."
      })
    ),
    popup: ActionPopupSchema
  },
  { dependentRequired: { tone: ["style"], style: ["tone"] } }
);

export const LinkButtonSchema = openObject({
  display: Type.String({ minLength: 1 }),
  icon: IconSchema,
  url: Type.String({ minLength: 1 })
});

const NumericVisualFields = {
  label: Type.String({ minLength: 1 }),
  value: Type.Number(),
  display: Type.String({ minLength: 1 }),
  unit: Type.Optional(nullable(Type.String())),
  min_value: Type.Number(),
  max_value: Type.Number()
};

export const CardVisualSchema = Type.Union(
  [
    openObject({ kind: Type.Literal("numeric_bar"), ...NumericVisualFields }),
    openObject({
      kind: Type.Literal("progress_ring"),
      ...NumericVisualFields,
      color: Type.Optional(
        nullable(
          Type.String({
            enum: [...SUPPORTED_COLORS],
            description: "A named color from the Agent Outbox product palette."
          })
        )
      )
    }),
    openObject({
      kind: Type.Literal("pill"),
      text: Type.String({ minLength: 1 }),
      icon: Type.Optional(nullable(IconSchema)),
      color: Type.String({
        enum: [...SUPPORTED_COLORS],
        description: "A named color from the Agent Outbox product palette."
      })
    })
  ],
  { discriminator: { propertyName: "kind" } }
);

const InputPrioritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("high"),
  Type.Literal("urgent")
]);

export const InputSubmissionSchema = openObject(
  {
    caller_item_id: Type.String({ minLength: 1 }),
    priority: Type.Optional(nullable(InputPrioritySchema)),
    row_type: openObject({
      display: Type.String({ minLength: 1 }),
      icon: IconSchema
    }),
    row_accent_color: Type.Optional(
      nullable(
        Type.String({
          enum: [...SUPPORTED_COLORS],
          description: "A named color from the Agent Outbox product palette."
        })
      )
    ),
    title: Type.String({ minLength: 1 }),
    subtitle: Type.String({ minLength: 1 }),
    corner: Type.Optional(nullable(Type.String())),
    summary: Type.String({ minLength: 1 }),
    details: Type.Optional(nullable(Type.String())),
    link_buttons: Type.Array(LinkButtonSchema, { maxItems: 32 }),
    card_visual: Type.Optional(nullable(CardVisualSchema)),
    skip_disabled: Type.Optional(nullable(Type.Boolean())),
    actions: Type.Array(InputActionSchema, { minItems: 1, maxItems: 32 })
  },
  {
    $id: "InputSubmission",
    title: "Input submission",
    description:
      "A complete, caller-owned review request. The server derives account and caller identity from the bearer credential. Optional fields may be omitted; the server stores and later returns the default-expanded canonical form."
  }
);

export const CanonicalRawInputSchema = closedObject(
  {
    caller_item_id: Type.String({ minLength: 1 }),
    priority: InputPrioritySchema,
    row_type: openObject({
      display: Type.String({ minLength: 1 }),
      icon: IconSchema
    }),
    row_accent_color: nullable(
      Type.String({
        enum: [...SUPPORTED_COLORS],
        description: "A named color from the Agent Outbox product palette."
      })
    ),
    title: Type.String({ minLength: 1 }),
    subtitle: Type.String({ minLength: 1 }),
    corner: nullable(Type.String()),
    summary: Type.String({ minLength: 1 }),
    details: nullable(Type.String()),
    link_buttons: Type.Array(LinkButtonSchema, { maxItems: 32 }),
    card_visual: nullable(CardVisualSchema),
    skip_disabled: Type.Boolean(),
    actions: Type.Array(InputActionSchema, { minItems: 1, maxItems: 32 })
  },
  {
    $id: "CanonicalRawInput",
    title: "Canonical accepted input",
    description:
      "The default-expanded submission Agent Outbox accepted and returns as raw_input. Request InputSubmission remains weaker so callers may omit defaults; this response shape always includes them."
  }
);

export const InputDeleteSchema = openObject(
  { caller_item_id: Type.String({ minLength: 1 }) },
  { $id: "InputDelete", title: "Delete pending input" }
);

export const InputReadRequestSchema = openObject(
  { caller_item_id: Type.String({ minLength: 1 }) },
  { $id: "InputReadRequest", title: "Read live input" }
);

export const OutputReadAllRequestSchema = openObject(
  {
    limit: Type.Optional(
      nullable(
        Type.Integer({
          minimum: 1,
          maximum: SYSTEM_CONTRACT.outputPageMaxLimit,
          default: SYSTEM_CONTRACT.outputPageDefaultLimit
        })
      )
    ),
    cursor: Type.Optional(nullable(Type.String({ minLength: 1 })))
  },
  { $id: "OutputReadAllRequest", title: "Read-all page request" }
);

const DateResponseSchema = closedObject({
  kind: Type.Literal("date_picker"),
  mode: Type.Literal("date"),
  value_date: Type.String({ format: "date" }),
  display_timezone: nullable(Type.String())
});

const DateTimeResponseSchema = closedObject({
  kind: Type.Literal("date_picker"),
  mode: Type.Literal("datetime"),
  value_utc: Type.String({ format: "date-time" }),
  display_timezone: nullable(Type.String())
});

export const ActionResponseSchema = Type.Union(
  [
    closedObject({ kind: Type.Literal("none") }),
    closedObject({ kind: Type.Literal("free_text"), text: Type.String() }),
    closedObject({
      kind: Type.Literal("single_select"),
      value: ProtocolValueSchema
    }),
    closedObject({
      kind: Type.Literal("multi_select"),
      values: Type.Array(ProtocolValueSchema)
    }),
    DateResponseSchema,
    DateTimeResponseSchema,
    closedObject({
      kind: Type.Literal("file_upload"),
      file: closedObject({
        file_id: Type.String({ minLength: 1 }),
        filename: Type.String({ minLength: 1 }),
        mime_type: Type.String({ minLength: 1 }),
        size_bytes: Type.Integer({ minimum: 0 }),
        sha256: Type.String({ pattern: hexDigestPattern })
      })
    })
  ],
  {
    description:
      "The human response. Date-picker responses share a kind and are distinguished by mode."
  }
);

export const OutputResultSchema = closedObject(
  {
    output_result_id: Type.String({ minLength: 1 }),
    caller_id: Type.String({ minLength: 1 }),
    caller_item_id: Type.String({ minLength: 1 }),
    action_value: ProtocolValueSchema,
    response: ActionResponseSchema,
    answered_at: Type.String({ format: "date-time" }),
    answered_by: nullable(Type.String({ minLength: 1 })),
    raw_input: CanonicalRawInputSchema
  },
  { $id: "OutputResult", title: "Output result" }
);

export const OutputCheckPageSchema = closedObject(
  {
    items: Type.Array(
      closedObject({
        output_result_id: Type.String({ minLength: 1 }),
        caller_item_id: Type.String({ minLength: 1 }),
        answered_at: Type.String({ format: "date-time" })
      })
    ),
    ready_count: Type.Integer({
      minimum: 0,
      description:
        "Total live results awaiting acknowledgement, including results already read."
    }),
    has_more: Type.Boolean(),
    next_cursor: nullable(Type.String({ minLength: 1 })),
    returned_count: Type.Integer({ minimum: 0 }),
    page_limit: Type.Integer({ minimum: 1 })
  },
  { $id: "OutputCheckPage", title: "Output readiness page" }
);

export const OutputReadPageSchema = closedObject(
  {
    items: Type.Array(OutputResultSchema),
    unavailable_outputs: Type.Array(
      closedObject({
        output_result_id: Type.String({ minLength: 1 }),
        code: Type.Literal("temporary_unavailable"),
        message: Type.Literal(
          "Output file metadata is temporarily unavailable."
        )
      })
    ),
    unavailable_count: Type.Integer({ minimum: 0 }),
    has_more: Type.Boolean(),
    next_cursor: nullable(Type.String({ minLength: 1 })),
    returned_count: Type.Integer({ minimum: 0 }),
    page_limit: Type.Integer({ minimum: 1 })
  },
  { $id: "OutputReadPage", title: "Output result page" }
);

const AccountStatusSchema = closedObject({
  account_id: Type.String({ minLength: 1 }),
  label: nullable(Type.String()),
  tier: Type.Union([
    Type.Literal("hosted_free"),
    Type.Literal("hosted_paid"),
    Type.Literal("self_hosted")
  ]),
  effective_tier: Type.Union([Type.Literal("free"), Type.Literal("paid")]),
  billing_status: Type.Union([
    Type.Literal("not_applicable"),
    Type.Literal("active"),
    Type.Literal("grace"),
    Type.Literal("past_due"),
    Type.Literal("canceled")
  ]),
  grace_ends_at: nullable(Type.String({ format: "date-time" })),
  file_upload_enabled: Type.Boolean(),
  storage: closedObject({
    stored_bytes: Type.Integer({ minimum: 0 }),
    limit_name: Type.String({ minLength: 1 }),
    limit_bytes: nullable(Type.Integer({ minimum: 0 }))
  }),
  active_limit_blocks: Type.Array(
    closedObject({
      operation_kind: Type.String({ minLength: 1 }),
      limit_name: Type.String({ minLength: 1 }),
      limit_reason_code: Type.String({ minLength: 1 }),
      limit_reason: Type.String({ minLength: 1 }),
      limit_resets_at: nullable(Type.String({ format: "date-time" })),
      used_units: nullable(Type.Integer({ minimum: 0 })),
      limit_units: nullable(Type.Integer({ minimum: 0 }))
    })
  )
});

const CallerStatusSchema = closedObject({
  caller: closedObject({
    caller_id: Type.String({ minLength: 1 }),
    caller_slug: nullable(Type.String()),
    display_name: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("pending_activation"),
      Type.Literal("active"),
      Type.Literal("revoked"),
      Type.Literal("expired")
    ]),
    key: closedObject({
      key_id: Type.String({ minLength: 1 }),
      prefix: Type.String({ minLength: 1 }),
      last_chars: Type.String({ minLength: 1 }),
      created_at: Type.String({ format: "date-time" }),
      last_used_at: nullable(Type.String({ format: "date-time" }))
    })
  }),
  account: AccountStatusSchema
});

const InputSendResultSchema = closedObject({
  caller_item_id: Type.String({ minLength: 1 }),
  status: Type.Literal("pending"),
  revision: Type.Integer({ minimum: 1 }),
  created: Type.Boolean(),
  duplicate: Type.Boolean()
});

const InputReplaceResultSchema = closedObject({
  caller_item_id: Type.String({ minLength: 1 }),
  status: Type.Literal("pending"),
  revision: Type.Integer({ minimum: 1 }),
  replaced: Type.Boolean(),
  changed: Type.Boolean()
});

const InputDeleteResultSchema = closedObject({
  caller_item_id: Type.String({ minLength: 1 }),
  deleted: Type.Literal(true)
});

const InputLiveMetadataFields = {
  caller_item_id: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("answered")]),
  revision: Type.Integer({ minimum: 1 }),
  created_at: Type.String({ format: "date-time" }),
  updated_at: Type.String({ format: "date-time" }),
  answered_at: nullable(Type.String({ format: "date-time" }))
};

const InputListItemSchema = closedObject(InputLiveMetadataFields);

export const InputListPageSchema = closedObject(
  {
    items: Type.Array(InputListItemSchema),
    has_more: Type.Boolean(),
    next_cursor: nullable(Type.String({ minLength: 1 })),
    returned_count: Type.Integer({ minimum: 0 }),
    page_limit: Type.Integer({ minimum: 1 })
  },
  { $id: "InputListPage", title: "Input list page" }
);

export const InputReadResultSchema = closedObject(
  {
    ...InputLiveMetadataFields,
    raw_input: CanonicalRawInputSchema
  },
  { $id: "InputReadResult", title: "Live input" }
);

const OutputAckResultSchema = closedObject({
  output_result_id: Type.String({ minLength: 1 }),
  acknowledged: Type.Literal(true),
  already_acknowledged: Type.Boolean()
});

export const ErrorEnvelopeSchema = closedObject(
  {
    ok: Type.Literal(false),
    request_id: Type.String({ minLength: 1 }),
    correlation_id: Type.String({ minLength: 1 }),
    error: openObject({
      code: Type.String({ enum: publicCallerApiErrorCodes }),
      message: Type.String({ minLength: 1 }),
      fields: Type.Optional(
        Type.Array(
          closedObject({
            path: Type.String(),
            code: Type.String({ minLength: 1 }),
            message: Type.String({ minLength: 1 })
          })
        )
      ),
      retry_after_seconds: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Unknown()),
      upgrade: Type.Optional(Type.Unknown()),
      error_id: Type.Optional(Type.String({ minLength: 1 }))
    })
  },
  { $id: "ErrorEnvelope", title: "Error response" }
);

const successEnvelope = (schema: TSchema) =>
  closedObject({
    ok: Type.Literal(true),
    request_id: Type.String({ minLength: 1 }),
    correlation_id: Type.String({ minLength: 1 }),
    data: schema
  });

export const PUBLIC_API_SCHEMAS = {
  Icon: IconSchema,
  InputAction: InputActionSchema,
  FreeTextPopup: FreeTextPopupSchema,
  SingleSelectPopup: SingleSelectPopupSchema,
  MultiSelectPopup: MultiSelectPopupSchema,
  DatePickerPopup: DatePickerPopupSchema,
  FileUploadPopup: FileUploadPopupSchema,
  ActionResponse: ActionResponseSchema,
  InputSubmission: InputSubmissionSchema,
  CanonicalRawInput: CanonicalRawInputSchema,
  InputDelete: InputDeleteSchema,
  InputReadRequest: InputReadRequestSchema,
  OutputReadAllRequest: OutputReadAllRequestSchema,
  InputSendResponse: successEnvelope(InputSendResultSchema),
  InputReplaceResponse: successEnvelope(InputReplaceResultSchema),
  InputDeleteResponse: successEnvelope(InputDeleteResultSchema),
  InputListResponse: successEnvelope(InputListPageSchema),
  InputReadResponse: successEnvelope(InputReadResultSchema),
  OutputCheckResponse: successEnvelope(OutputCheckPageSchema),
  OutputResultResponse: successEnvelope(OutputResultSchema),
  OutputReadPageResponse: successEnvelope(OutputReadPageSchema),
  OutputAckResponse: successEnvelope(OutputAckResultSchema),
  CallerStatusResponse: successEnvelope(CallerStatusSchema),
  AccountStatusResponse: successEnvelope(AccountStatusSchema),
  ErrorEnvelope: ErrorEnvelopeSchema
} as const;

const inputSubmissionExample = {
  caller_item_id: "email:thread_123",
  priority: "high",
  row_type: { display: "Email draft", icon: "mail" },
  title: "Reply to Acme Corp",
  subtitle: "A customer response is ready for review.",
  summary: "Approve the prepared response before it is sent.",
  link_buttons: [],
  actions: [
    {
      display: "Approve to send",
      icon: "send",
      value: "approve_send",
      overflow: false,
      tone: "success",
      style: "solid",
      popup: { kind: "none" }
    }
  ]
} as const;

const canonicalRawInputExample = {
  ...inputSubmissionExample,
  row_accent_color: null,
  corner: null,
  details: null,
  card_visual: null,
  skip_disabled: false
} as const;

export const PUBLIC_API_EXAMPLES = {
  inputSubmission: inputSubmissionExample,
  canonicalRawInput: canonicalRawInputExample,
  sendSuccess: {
    ok: true,
    request_id: "req_123",
    correlation_id: "corr_123",
    data: {
      caller_item_id: "email:thread_123",
      status: "pending",
      revision: 1,
      created: true,
      duplicate: false
    }
  },
  checkSuccess: {
    ok: true,
    request_id: "req_124",
    correlation_id: "corr_124",
    data: {
      items: [
        {
          output_result_id: "out_123",
          caller_item_id: "email:thread_123",
          answered_at: "2026-06-30T20:00:00Z"
        }
      ],
      ready_count: 1,
      has_more: false,
      next_cursor: null,
      returned_count: 1,
      page_limit: 25
    }
  },
  readSuccess: {
    ok: true,
    request_id: "req_125",
    correlation_id: "corr_125",
    data: {
      output_result_id: "out_123",
      caller_id: "caller_123",
      caller_item_id: "email:thread_123",
      action_value: "approve_send",
      response: { kind: "none" },
      answered_at: "2026-06-30T20:00:00Z",
      answered_by: "user_123",
      raw_input: canonicalRawInputExample
    }
  },
  deleteInput: { caller_item_id: "email:thread_123" },
  readInput: { caller_item_id: "email:thread_123" },
  readAllRequest: { limit: 25, cursor: null },
  listInputsSuccess: {
    ok: true,
    request_id: "req_126",
    correlation_id: "corr_126",
    data: {
      items: [
        {
          caller_item_id: "email:thread_123",
          status: "pending",
          revision: 1,
          created_at: "2026-06-30T19:00:00Z",
          updated_at: "2026-06-30T19:00:00Z",
          answered_at: null
        }
      ],
      has_more: false,
      next_cursor: null,
      returned_count: 1,
      page_limit: 25
    }
  },
  readInputSuccess: {
    ok: true,
    request_id: "req_127",
    correlation_id: "corr_127",
    data: {
      caller_item_id: "email:thread_123",
      status: "pending",
      revision: 1,
      created_at: "2026-06-30T19:00:00Z",
      updated_at: "2026-06-30T19:00:00Z",
      answered_at: null,
      raw_input: canonicalRawInputExample
    }
  }
} as const;

export type PublicApiOperation = Readonly<{
  id: string;
  method: "get" | "post";
  path: string;
  group: "Inputs" | "Outputs" | "Status";
  summary: string;
  description: string;
  behavior: readonly string[];
  requestSchema?: keyof typeof PUBLIC_API_SCHEMAS;
  responseSchema?: keyof typeof PUBLIC_API_SCHEMAS;
  errorStatuses: readonly (
    400 | 401 | 402 | 404 | 409 | 413 | 422 | 429 | 500 | 503
  )[];
  query?: readonly Readonly<{
    name: string;
    description: string;
    schema: TSchema;
  }>[];
  pathParameters?: readonly Readonly<{
    name: string;
    description: string;
  }>[];
  exampleKey?: keyof typeof PUBLIC_API_EXAMPLES;
  responseExampleKey?: keyof typeof PUBLIC_API_EXAMPLES;
}>;

export const PUBLIC_API_OPERATIONS = [
  {
    id: "sendInput",
    method: "post",
    path: "/api/input/send",
    group: "Inputs",
    summary: "Send a review request",
    description:
      "Creates a pending human review request. Repeating the same caller item and normalized content is an idempotent success.",
    behavior: [
      "Use a stable caller_item_id for the logical work item.",
      "A same-content retry is safe; different content for the same pending id returns a conflict.",
      "Account and caller identity always come from the bearer credential."
    ],
    requestSchema: "InputSubmission",
    responseSchema: "InputSendResponse",
    errorStatuses: [400, 401, 402, 409, 413, 422, 429, 500, 503],
    exampleKey: "inputSubmission",
    responseExampleKey: "sendSuccess"
  },
  {
    id: "replaceInput",
    method: "post",
    path: "/api/input/replace",
    group: "Inputs",
    summary: "Replace a pending request",
    description:
      "Replaces the complete content of a still-pending request and advances its revision only when normalized content changes.",
    behavior: [
      "Send the complete replacement, not a partial patch.",
      "Answered or missing items cannot be replaced."
    ],
    requestSchema: "InputSubmission",
    responseSchema: "InputReplaceResponse",
    errorStatuses: [400, 401, 402, 404, 409, 413, 422, 429, 500, 503],
    exampleKey: "inputSubmission"
  },
  {
    id: "deleteInput",
    method: "post",
    path: "/api/input/delete",
    group: "Inputs",
    summary: "Delete a pending request",
    description:
      "Deletes a request only while it is pending. This cleanup operation remains available after monthly quota exhaustion.",
    behavior: [
      "Answered items and output results are not deleted by this route."
    ],
    requestSchema: "InputDelete",
    responseSchema: "InputDeleteResponse",
    errorStatuses: [400, 401, 404, 409, 413, 422, 429, 503],
    exampleKey: "deleteInput"
  },
  {
    id: "listInputs",
    method: "get",
    path: "/api/input/list",
    group: "Inputs",
    summary: "List live retained inputs",
    description:
      "Returns metadata for live retained inputs owned by the authenticated caller in stable opaque-cursor order.",
    behavior: [
      "Pending and answered-but-unacknowledged inputs are visible; deleted, acknowledged, expired, and retention-cleaned inputs are not.",
      "This route is non-mutating and does not return input bodies.",
      `Page size is 1 to ${SYSTEM_CONTRACT.outputPageMaxLimit} and defaults to ${SYSTEM_CONTRACT.outputPageDefaultLimit}.`,
      "Follow next_cursor while has_more is true.",
      "Shares the output_check_read per-minute limit and consumes monthly API request quota."
    ],
    responseSchema: "InputListResponse",
    errorStatuses: [400, 401, 422, 429, 503],
    responseExampleKey: "listInputsSuccess",
    query: [
      {
        name: "limit",
        description: `Page size from 1 to ${SYSTEM_CONTRACT.outputPageMaxLimit}. Defaults to ${SYSTEM_CONTRACT.outputPageDefaultLimit}.`,
        schema: Type.Integer({
          minimum: 1,
          maximum: SYSTEM_CONTRACT.outputPageMaxLimit,
          default: SYSTEM_CONTRACT.outputPageDefaultLimit
        })
      },
      {
        name: "cursor",
        description: "Opaque next_cursor from the preceding page.",
        schema: Type.String({ minLength: 1 })
      }
    ]
  },
  {
    id: "readInput",
    method: "post",
    path: "/api/input/read",
    group: "Inputs",
    summary: "Read one live retained input",
    description:
      "Returns one complete canonical accepted input for a live caller_item_id owned by the authenticated caller.",
    behavior: [
      "raw_input is the validated, sanitized, default-expanded submission Agent Outbox accepted, not the original request JSON.",
      "A JSON body is required because caller_item_id is arbitrary caller-owned text and is not URL-safe.",
      "Missing live items return not_found. This route is non-mutating.",
      "Shares the output_check_read per-minute limit and consumes monthly API request quota."
    ],
    requestSchema: "InputReadRequest",
    responseSchema: "InputReadResponse",
    errorStatuses: [400, 401, 404, 413, 422, 429, 503],
    exampleKey: "readInput",
    responseExampleKey: "readInputSuccess"
  },
  {
    id: "checkOutput",
    method: "get",
    path: "/api/output/check",
    group: "Outputs",
    summary: "Check whether decisions are ready",
    description:
      "Returns readiness metadata without returning answers, marking results read, or disabling human undo.",
    behavior: [
      "Poll only when your caller is ready to continue.",
      "ready_count includes every live unacknowledged result, even if it was already read.",
      "Follow next_cursor while has_more is true."
    ],
    responseSchema: "OutputCheckResponse",
    errorStatuses: [400, 401, 422, 429, 503],
    responseExampleKey: "checkSuccess",
    query: [
      {
        name: "limit",
        description: `Page size from 1 to ${SYSTEM_CONTRACT.outputPageMaxLimit}. Defaults to ${SYSTEM_CONTRACT.outputPageDefaultLimit}.`,
        schema: Type.Integer({
          minimum: 1,
          maximum: SYSTEM_CONTRACT.outputPageMaxLimit,
          default: SYSTEM_CONTRACT.outputPageDefaultLimit
        })
      },
      {
        name: "cursor",
        description: "Opaque next_cursor from the preceding page.",
        schema: Type.String({ minLength: 1 })
      }
    ]
  },
  {
    id: "readOutput",
    method: "post",
    path: "/api/output/{output_result_id}/read",
    group: "Outputs",
    summary: "Read one human decision",
    description:
      "Returns one complete decision and the matching canonical accepted input. The first successful read marks it read and permanently disables human undo.",
    behavior: [
      "The same result remains readable until acknowledgement.",
      "raw_input is the canonical accepted submission for the matching live input.",
      "Use output_result_id as the idempotency key for downstream work."
    ],
    responseSchema: "OutputResultResponse",
    errorStatuses: [400, 401, 404, 429, 503],
    responseExampleKey: "readSuccess",
    pathParameters: [
      {
        name: "output_result_id",
        description: "The result id returned by output/check."
      }
    ]
  },
  {
    id: "readAllOutputs",
    method: "post",
    path: "/api/output/read-all",
    group: "Outputs",
    summary: "Read a page of human decisions",
    description:
      "Returns full decisions and matching canonical accepted inputs in oldest-first order, and marks only returned items read.",
    behavior: [
      "Each returned item includes raw_input for the matching live input.",
      "Unavailable file metadata is reported separately and does not mark that result read.",
      "File-metadata degradation stays isolated; it does not require canonical input reconstruction.",
      "Because each item includes the full canonical input, choose a smaller limit when submissions are large.",
      "Follow next_cursor while has_more is true."
    ],
    requestSchema: "OutputReadAllRequest",
    responseSchema: "OutputReadPageResponse",
    errorStatuses: [400, 401, 413, 422, 429, 503],
    exampleKey: "readAllRequest"
  },
  {
    id: "acknowledgeOutput",
    method: "post",
    path: "/api/output/{output_result_id}/ack",
    group: "Outputs",
    summary: "Acknowledge durable handling",
    description:
      "Idempotently confirms that downstream handling is durable, then removes the live input/output pair and attached files.",
    behavior: [
      "Acknowledge only after your side effect or record is durable.",
      "Duplicate acknowledgement is a successful no-op when retained audit data proves the prior acknowledgement."
    ],
    responseSchema: "OutputAckResponse",
    errorStatuses: [400, 401, 404, 429, 503],
    pathParameters: [
      {
        name: "output_result_id",
        description: "The result id that has been handled durably."
      }
    ]
  },
  {
    id: "downloadOutputFile",
    method: "get",
    path: "/api/output/{output_result_id}/files/{file_id}",
    group: "Outputs",
    summary: "Download response file bytes",
    description:
      "Returns authenticated raw bytes for a file described in an output result. File content never appears in JSON.",
    behavior: [
      "Treat the stored MIME type as advisory.",
      "Downloads are unavailable after acknowledgement or retention cleanup."
    ],
    errorStatuses: [401, 404, 429, 503],
    pathParameters: [
      {
        name: "output_result_id",
        description: "The result containing the file response."
      },
      { name: "file_id", description: "The file id from response.file." }
    ]
  },
  {
    id: "getCallerStatus",
    method: "get",
    path: "/api/caller/status",
    group: "Status",
    summary: "Inspect caller and account status",
    description:
      "Returns non-secret caller credential metadata plus account tier, storage, and active limit information.",
    behavior: [
      "last_used_at may lag recent valid requests by up to 15 minutes."
    ],
    responseSchema: "CallerStatusResponse",
    errorStatuses: [401, 429, 503]
  },
  {
    id: "getAccountStatus",
    method: "get",
    path: "/api/account/status",
    group: "Status",
    summary: "Inspect account status",
    description:
      "Returns the bearer credential's non-secret account tier, storage, and active limit information.",
    behavior: [
      "This route still requires an existing caller bearer credential."
    ],
    responseSchema: "AccountStatusResponse",
    errorStatuses: [401, 429, 503]
  }
] as const satisfies readonly PublicApiOperation[];

export const PUBLIC_API_ROUTE_KEYS = PUBLIC_API_OPERATIONS.map(
  ({ method, path }) => `${method.toUpperCase()} ${path}`
);

function jsonPointerToFieldPath(pointer: string | undefined): string {
  if (!pointer) {
    return "";
  }
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((path, segment) => {
      if (/^\d+$/.test(segment)) {
        return `${path}[${segment}]`;
      }
      return path ? `${path}.${segment}` : segment;
    }, "");
}

export function publicSchemaFieldErrors(
  schema: TSchema,
  value: unknown,
  fallbackMessage: string
): Array<{ path: string; code: "contract_mismatch"; message: string }> {
  const byPath = new Map<string, string>();
  for (const error of Value.Errors(schema, value)) {
    byPath.set(jsonPointerToFieldPath(error.instancePath), error.message);
  }
  if (byPath.size === 0) {
    return [
      {
        path: "",
        code: "contract_mismatch",
        message: fallbackMessage
      }
    ];
  }
  return [...byPath.entries()].map(([path, message]) => ({
    path,
    code: "contract_mismatch",
    message
  }));
}

export function publicInputSubmissionShapeMatches(value: unknown): boolean {
  return Value.Check(InputSubmissionSchema, value);
}

export function publicCanonicalRawInputShapeMatches(value: unknown): boolean {
  return Value.Check(CanonicalRawInputSchema, value);
}

export function publicInputDeleteShapeMatches(value: unknown): boolean {
  return Value.Check(InputDeleteSchema, value);
}

export function publicInputReadShapeMatches(value: unknown): boolean {
  return Value.Check(InputReadRequestSchema, value);
}

export function publicOutputReadAllShapeMatches(value: unknown): boolean {
  return Value.Check(OutputReadAllRequestSchema, value);
}

export function publicSchemaMatches(
  schemaName: keyof typeof PUBLIC_API_SCHEMAS,
  value: unknown
): boolean {
  return Value.Check(PUBLIC_API_SCHEMAS[schemaName], value);
}

export function validatePublicApiContract() {
  const operationIds = new Set<string>();
  const routeKeys = new Set<string>();

  for (const operation of PUBLIC_API_OPERATIONS as readonly PublicApiOperation[]) {
    if (operationIds.has(operation.id)) {
      throw new Error(`Duplicate public API operation id: ${operation.id}`);
    }
    operationIds.add(operation.id);

    const routeKey = `${operation.method.toUpperCase()} ${operation.path}`;
    if (routeKeys.has(routeKey)) {
      throw new Error(`Duplicate public API operation route: ${routeKey}`);
    }
    routeKeys.add(routeKey);

    if (
      operation.exampleKey &&
      operation.requestSchema &&
      !publicSchemaMatches(
        operation.requestSchema,
        PUBLIC_API_EXAMPLES[operation.exampleKey]
      )
    ) {
      throw new Error(
        `Public API example ${operation.exampleKey} does not match ${operation.requestSchema}.`
      );
    }
    if (
      operation.responseExampleKey &&
      operation.responseSchema &&
      !publicSchemaMatches(
        operation.responseSchema,
        PUBLIC_API_EXAMPLES[operation.responseExampleKey]
      )
    ) {
      throw new Error(
        `Public API response example ${operation.responseExampleKey} does not match ${operation.responseSchema}.`
      );
    }
  }
}
