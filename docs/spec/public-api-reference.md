# API reference

This reference is generated from the same executable schemas used to check
public examples and runtime request structure. Human-written guides explain when
and why to use each operation; this page records the exact HTTP contract.

[Download the OpenAPI 3.1 document](../openapi.json)

## Common request rules

All hosted routes use `https://app.agent-outbox.dev/api`. Caller operations
require `Authorization: Bearer <caller_api_key>`; JSON bodies require
`Content-Type: application/json`.

JSON responses include `request_id` and `correlation_id`. Successful downloads
return raw bytes with the same ids in response headers.

## Inputs

### `POST /api/input/send`

**Send a review request.** Creates a pending human review request. Repeating the
same caller item and normalized content is an idempotent success.

- Use a stable caller_item_id for the logical work item.
- A same-content retry is safe; different content for the same pending id
  returns a conflict.
- Account and caller identity always come from the bearer credential.

Request body: [`InputSubmission`](#schema-inputsubmission)

```json
{
  "caller_item_id": "email:thread_123",
  "priority": "high",
  "row_type": {
    "display": "Email draft",
    "icon": "mail"
  },
  "title": "Reply to Acme Corp",
  "subtitle": "A customer response is ready for review.",
  "summary": "Approve the prepared response before it is sent.",
  "link_buttons": [],
  "actions": [
    {
      "display": "Approve to send",
      "icon": "send",
      "value": "approve_send",
      "overflow": false,
      "tone": "success",
      "style": "solid",
      "popup": {
        "kind": "none"
      }
    }
  ]
}
```

Success envelope: [`InputSendResponse`](#schema-inputsendresponse)

```json
{
  "ok": true,
  "request_id": "req_123",
  "correlation_id": "corr_123",
  "data": {
    "caller_item_id": "email:thread_123",
    "status": "pending",
    "revision": 1,
    "created": true,
    "duplicate": false
  }
}
```

### `POST /api/input/replace`

**Replace a pending request.** Replaces the complete content of a still-pending
request and advances its revision only when normalized content changes.

- Send the complete replacement, not a partial patch.
- Answered or missing items cannot be replaced.

Request body: [`InputSubmission`](#schema-inputsubmission)

```json
{
  "caller_item_id": "email:thread_123",
  "priority": "high",
  "row_type": {
    "display": "Email draft",
    "icon": "mail"
  },
  "title": "Reply to Acme Corp",
  "subtitle": "A customer response is ready for review.",
  "summary": "Approve the prepared response before it is sent.",
  "link_buttons": [],
  "actions": [
    {
      "display": "Approve to send",
      "icon": "send",
      "value": "approve_send",
      "overflow": false,
      "tone": "success",
      "style": "solid",
      "popup": {
        "kind": "none"
      }
    }
  ]
}
```

Success envelope: [`InputReplaceResponse`](#schema-inputreplaceresponse)

### `POST /api/input/delete`

**Delete a pending request.** Deletes a request only while it is pending. This
cleanup operation remains available after monthly quota exhaustion.

- Answered items and output results are not deleted by this route.

Request body: [`InputDelete`](#schema-inputdelete)

```json
{
  "caller_item_id": "email:thread_123"
}
```

Success envelope: [`InputDeleteResponse`](#schema-inputdeleteresponse)

### `GET /api/input/list`

**List live retained inputs.** Returns metadata for live retained inputs owned
by the authenticated caller in stable opaque-cursor order.

- Pending and answered-but-unacknowledged inputs are visible; deleted,
  acknowledged, expired, and retention-cleaned inputs are not.
- This route is non-mutating and does not return input bodies.
- Page size is 1 to 100 and defaults to 25.
- Follow next_cursor while has_more is true.
- Shares the output_check_read per-minute limit and consumes monthly API request
  quota.

Query parameters:

| Name     | Meaning                                     |
| -------- | ------------------------------------------- |
| `limit`  | Page size from 1 to 100. Defaults to 25.    |
| `cursor` | Opaque next_cursor from the preceding page. |

Success envelope: [`InputListResponse`](#schema-inputlistresponse)

```json
{
  "ok": true,
  "request_id": "req_126",
  "correlation_id": "corr_126",
  "data": {
    "items": [
      {
        "caller_item_id": "email:thread_123",
        "status": "pending",
        "revision": 1,
        "created_at": "2026-06-30T19:00:00Z",
        "updated_at": "2026-06-30T19:00:00Z",
        "answered_at": null
      }
    ],
    "has_more": false,
    "next_cursor": null,
    "returned_count": 1,
    "page_limit": 25
  }
}
```

### `POST /api/input/read`

**Read one live retained input.** Returns one complete canonical accepted input
for a live caller_item_id owned by the authenticated caller.

- raw_input is the validated, sanitized, default-expanded submission Agent
  Outbox accepted, not the original request JSON.
- A JSON body is required because caller_item_id is arbitrary caller-owned text
  and is not URL-safe.
- Missing live items return not_found. This route is non-mutating.
- Shares the output_check_read per-minute limit and consumes monthly API request
  quota.

Request body: [`InputReadRequest`](#schema-inputreadrequest)

```json
{
  "caller_item_id": "email:thread_123"
}
```

Success envelope: [`InputReadResponse`](#schema-inputreadresponse)

```json
{
  "ok": true,
  "request_id": "req_127",
  "correlation_id": "corr_127",
  "data": {
    "caller_item_id": "email:thread_123",
    "status": "pending",
    "revision": 1,
    "created_at": "2026-06-30T19:00:00Z",
    "updated_at": "2026-06-30T19:00:00Z",
    "answered_at": null,
    "raw_input": {
      "caller_item_id": "email:thread_123",
      "priority": "high",
      "row_type": {
        "display": "Email draft",
        "icon": "mail"
      },
      "title": "Reply to Acme Corp",
      "subtitle": "A customer response is ready for review.",
      "summary": "Approve the prepared response before it is sent.",
      "link_buttons": [],
      "actions": [
        {
          "display": "Approve to send",
          "icon": "send",
          "value": "approve_send",
          "overflow": false,
          "tone": "success",
          "style": "solid",
          "popup": {
            "kind": "none"
          }
        }
      ],
      "row_accent_color": null,
      "corner": null,
      "card_time": null,
      "details": null,
      "card_visual": null,
      "skip_disabled": false
    }
  }
}
```

## Outputs

### `GET /api/output/check`

**Check whether decisions are ready.** Returns readiness metadata without
returning answers, marking results read, or disabling human undo.

- Poll only when your caller is ready to continue.
- ready_count includes every live unacknowledged result, even if it was already
  read.
- Follow next_cursor while has_more is true.

Query parameters:

| Name     | Meaning                                     |
| -------- | ------------------------------------------- |
| `limit`  | Page size from 1 to 100. Defaults to 25.    |
| `cursor` | Opaque next_cursor from the preceding page. |

Success envelope: [`OutputCheckResponse`](#schema-outputcheckresponse)

```json
{
  "ok": true,
  "request_id": "req_124",
  "correlation_id": "corr_124",
  "data": {
    "items": [
      {
        "output_result_id": "out_123",
        "caller_item_id": "email:thread_123",
        "answered_at": "2026-06-30T20:00:00Z"
      }
    ],
    "ready_count": 1,
    "has_more": false,
    "next_cursor": null,
    "returned_count": 1,
    "page_limit": 25
  }
}
```

### `POST /api/output/{output_result_id}/read`

**Read one human decision.** Returns one complete decision and the matching
canonical accepted input. The first successful read marks it read and
permanently disables human undo.

- The same result remains readable until acknowledgement.
- raw_input is the canonical accepted submission for the matching live input.
- Use output_result_id as the idempotency key for downstream work.

Path parameters:

| Name               | Meaning                                 |
| ------------------ | --------------------------------------- |
| `output_result_id` | The result id returned by output/check. |

Success envelope: [`OutputResultResponse`](#schema-outputresultresponse)

```json
{
  "ok": true,
  "request_id": "req_125",
  "correlation_id": "corr_125",
  "data": {
    "output_result_id": "out_123",
    "caller_id": "caller_123",
    "caller_item_id": "email:thread_123",
    "action_value": "approve_send",
    "response": {
      "kind": "none"
    },
    "answered_at": "2026-06-30T20:00:00Z",
    "answered_by": "user_123",
    "raw_input": {
      "caller_item_id": "email:thread_123",
      "priority": "high",
      "row_type": {
        "display": "Email draft",
        "icon": "mail"
      },
      "title": "Reply to Acme Corp",
      "subtitle": "A customer response is ready for review.",
      "summary": "Approve the prepared response before it is sent.",
      "link_buttons": [],
      "actions": [
        {
          "display": "Approve to send",
          "icon": "send",
          "value": "approve_send",
          "overflow": false,
          "tone": "success",
          "style": "solid",
          "popup": {
            "kind": "none"
          }
        }
      ],
      "row_accent_color": null,
      "corner": null,
      "card_time": null,
      "details": null,
      "card_visual": null,
      "skip_disabled": false
    }
  }
}
```

### `POST /api/output/read-all`

**Read a page of human decisions.** Returns full decisions and matching
canonical accepted inputs in oldest-first order, and marks only returned items
read.

- Each returned item includes raw_input for the matching live input.
- Unavailable file metadata is reported separately and does not mark that result
  read.
- File-metadata degradation stays isolated; it does not require canonical input
  reconstruction.
- Because each item includes the full canonical input, choose a smaller limit
  when submissions are large.
- Follow next_cursor while has_more is true.

Request body: [`OutputReadAllRequest`](#schema-outputreadallrequest)

```json
{
  "limit": 25,
  "cursor": null
}
```

Success envelope: [`OutputReadPageResponse`](#schema-outputreadpageresponse)

### `POST /api/output/{output_result_id}/ack`

**Acknowledge durable handling.** Idempotently confirms that downstream handling
is durable, then removes the live input/output pair and attached files.

- Acknowledge only after your side effect or record is durable.
- Duplicate acknowledgement is a successful no-op when retained audit data
  proves the prior acknowledgement.

Path parameters:

| Name               | Meaning                                      |
| ------------------ | -------------------------------------------- |
| `output_result_id` | The result id that has been handled durably. |

Success envelope: [`OutputAckResponse`](#schema-outputackresponse)

### `GET /api/output/{output_result_id}/files/{file_id}`

**Download response file bytes.** Returns authenticated raw bytes for a file
described in an output result. File content never appears in JSON.

- Treat the stored MIME type as advisory.
- Downloads are unavailable after acknowledgement or retention cleanup.

Path parameters:

| Name               | Meaning                                  |
| ------------------ | ---------------------------------------- |
| `output_result_id` | The result containing the file response. |
| `file_id`          | The file id from response.file.          |

Success: authenticated raw bytes with attachment, content type, content length,
no-store, request id, and correlation id headers.

## Status

### `GET /api/caller/status`

**Inspect caller and account status.** Returns non-secret caller credential
metadata plus account tier, storage, and active limit information.

- last_used_at may lag recent valid requests by up to 15 minutes.

Success envelope: [`CallerStatusResponse`](#schema-callerstatusresponse)

### `GET /api/account/status`

**Inspect account status.** Returns the bearer credential's non-secret account
tier, storage, and active limit information.

- This route still requires an existing caller bearer credential.

Success envelope: [`AccountStatusResponse`](#schema-accountstatusresponse)

## Error codes

Branch on the stable `error.code`, not the human-readable message or HTTP status
alone. `error.fields` identifies invalid paths; retry, limit, upgrade, and
support metadata appear only when relevant.

| Code                         | Status | Meaning                                                             | Caller recovery                                                           |
| ---------------------------- | -----: | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `invalid_request`            |    400 | The request shape, query, method, or headers are invalid.           | Correct the request before retrying.                                      |
| `invalid_json`               |    400 | The request body is not valid JSON.                                 | Serialize a valid JSON body before retrying.                              |
| `request_too_large`          |    413 | The JSON request body exceeds its byte limit.                       | Reduce the request below the documented limit.                            |
| `validation_failed`          |    422 | One or more fields fail structural or semantic validation.          | Use error.fields to correct each rejected path.                           |
| `unsupported_icon`           |    422 | An icon is not in the supported Lucide allowlist.                   | Choose a value from the generated icon enum.                              |
| `unsafe_html`                |    422 | Display HTML contains unsafe markup, attributes, or URLs.           | Remove active or unsupported markup and retry.                            |
| `unsafe_color`               |    422 | A submitted color is not in the supported product palette.          | Choose a value from the generated color enum.                             |
| `upgrade_required`           |    402 | The caller requested a capability unavailable on its tier.          | Follow error.upgrade or remove the gated capability.                      |
| `retention_limit_exceeded`   |    429 | Retention state requires expired or excess live work to be removed. | Read, acknowledge, or delete live work as indicated by limit metadata.    |
| `billing_grace_expired`      |    402 | Billing grace ended and current tier limits now apply.              | Restore billing or reduce usage to the current tier.                      |
| `authentication_required`    |    401 | No usable bearer credential was supplied.                           | Send the connected caller credential as a bearer token.                   |
| `invalid_caller_credentials` |    401 | The caller credential is invalid or no longer usable.               | Reconnect or rotate the caller; lifecycle detail is intentionally hidden. |
| `not_found`                  |    404 | The live resource is absent or unavailable to this caller.          | Stop retrying the id unless caller state proves it should still be live.  |
| `pending_content_conflict`   |    409 | A pending caller_item_id already has different normalized content.  | Use input/replace when the pending request truly changed.                 |
| `answered_unacknowledged`    |    409 | The item is answered and its output is still unacknowledged.        | Read and durably handle the output, then acknowledge it.                  |
| `input_not_pending`          |    409 | Replace or delete targeted an item that is no longer pending.       | Stop the pending-item operation and reconcile current output state.       |
| `rate_limit_exceeded`        |    429 | A fixed-window or burst limit blocked the request.                  | Honor Retry-After and retry with backoff and jitter.                      |
| `quota_limit_exceeded`       |    429 | An account request or submission quota blocked the operation.       | Inspect error.limit and wait for reset or reduce usage.                   |
| `storage_limit_exceeded`     |    429 | A queue or stored-byte limit blocked storage-producing work.        | Delete pending work or acknowledge handled output to free storage.        |
| `temporary_unavailable`      |    503 | A transient dependency or runtime failure blocked the operation.    | Retry safe operations with bounded exponential backoff and jitter.        |
| `internal_error`             |    500 | An unexpected server error occurred.                                | Retry only when safe and retain request, correlation, and error ids.      |

## Schemas

These JSON Schema 2020-12 definitions are generated into the OpenAPI document.
Specialized semantic rules—such as safe HTML, supported icons, unique protocol
values, date ranges, and account entitlements—are applied after structural
validation and described in the guides.

### Schema: Icon

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "string",
  "enum": [
    "archive",
    "at-sign",
    "calendar",
    "check",
    "chevron-down",
    "clock",
    "credit-card",
    "download",
    "external-link",
    "file",
    "flask-conical",
    "inbox",
    "mail",
    "message-square",
    "paperclip",
    "rocket",
    "send",
    "trash",
    "upload",
    "user-plus",
    "x"
  ],
  "description": "A supported Lucide icon name. Arbitrary SVG and HTML are rejected."
}</code></pre></details>

### Schema: InputAction

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "display",
    "icon",
    "value",
    "overflow",
    "popup"
  ],
  "properties": {
    "display": {
      "type": "string",
      "minLength": 1
    },
    "icon": {
      "$ref": "#/components/schemas/Icon"
    },
    "value": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._:-]{1,128}$",
      "description": "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
    },
    "overflow": {
      "type": "boolean"
    },
    "tone": {
      "type": "string",
      "enum": [
        "neutral",
        "brand",
        "success",
        "warning",
        "danger"
      ],
      "description": "A fixed semantic color token. Supply tone and style together, or omit both for the legacy placement-based appearance."
    },
    "style": {
      "type": "string",
      "enum": [
        "solid",
        "outline",
        "ghost"
      ],
      "description": "A fixed button treatment. Supply tone and style together, or omit both for the legacy placement-based appearance."
    },
    "popup": {
      "oneOf": [
        {
          "type": "object",
          "required": [
            "kind"
          ],
          "properties": {
            "kind": {
              "type": "string",
              "const": "none"
            }
          },
          "additionalProperties": true
        },
        {
          "$ref": "#/components/schemas/FreeTextPopup"
        },
        {
          "$ref": "#/components/schemas/SingleSelectPopup"
        },
        {
          "$ref": "#/components/schemas/MultiSelectPopup"
        },
        {
          "$ref": "#/components/schemas/DatePickerPopup"
        },
        {
          "$ref": "#/components/schemas/FileUploadPopup"
        }
      ],
      "discriminator": {
        "propertyName": "kind"
      },
      "description": "The interaction shown after a human selects this action. The response uses the same kind."
    }
  },
  "dependentRequired": {
    "tone": [
      "style"
    ],
    "style": [
      "tone"
    ]
  },
  "additionalProperties": true
}</code></pre></details>

### Schema: FreeTextPopup

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "kind",
    "label",
    "multiline"
  ],
  "properties": {
    "kind": {
      "type": "string",
      "const": "free_text"
    },
    "label": {
      "type": "string",
      "minLength": 1
    },
    "placeholder": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "default_value": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "multiline": {
      "type": "boolean"
    },
    "min_length": {
      "oneOf": [
        {
          "type": "integer",
          "minimum": 0
        },
        {
          "type": "null"
        }
      ]
    },
    "max_length": {
      "oneOf": [
        {
          "type": "integer",
          "minimum": 1
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "additionalProperties": true
}</code></pre></details>

### Schema: SingleSelectPopup

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "kind",
    "label",
    "options"
  ],
  "properties": {
    "kind": {
      "type": "string",
      "const": "single_select"
    },
    "label": {
      "type": "string",
      "minLength": 1
    },
    "options": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "display",
          "value"
        ],
        "properties": {
          "display": {
            "type": "string",
            "minLength": 1
          },
          "value": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:-]{1,128}$",
            "description": "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
          },
          "icon": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Icon"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "minItems": 1,
      "maxItems": 64
    }
  },
  "additionalProperties": true
}</code></pre></details>

### Schema: MultiSelectPopup

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "kind",
    "label",
    "options"
  ],
  "properties": {
    "kind": {
      "type": "string",
      "const": "multi_select"
    },
    "label": {
      "type": "string",
      "minLength": 1
    },
    "options": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "display",
          "value"
        ],
        "properties": {
          "display": {
            "type": "string",
            "minLength": 1
          },
          "value": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:-]{1,128}$",
            "description": "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
          },
          "icon": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/Icon"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "additionalProperties": true
      },
      "minItems": 1,
      "maxItems": 64
    },
    "min_selected": {
      "oneOf": [
        {
          "type": "integer",
          "minimum": 0
        },
        {
          "type": "null"
        }
      ]
    },
    "max_selected": {
      "oneOf": [
        {
          "type": "integer",
          "minimum": 0
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "additionalProperties": true
}</code></pre></details>

### Schema: DatePickerPopup

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "kind",
    "label",
    "mode"
  ],
  "properties": {
    "kind": {
      "type": "string",
      "const": "date_picker"
    },
    "label": {
      "type": "string",
      "minLength": 1
    },
    "mode": {
      "oneOf": [
        {
          "type": "string",
          "const": "date"
        },
        {
          "type": "string",
          "const": "datetime"
        }
      ]
    },
    "placeholder": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "display_timezone": {
      "oneOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "min_value": {
      "oneOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "max_value": {
      "oneOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "additionalProperties": true
}</code></pre></details>

### Schema: FileUploadPopup

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "kind",
    "label"
  ],
  "properties": {
    "kind": {
      "type": "string",
      "const": "file_upload"
    },
    "label": {
      "type": "string",
      "minLength": 1
    },
    "accept_mime_types": {
      "oneOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 3
          },
          "minItems": 1
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "additionalProperties": true
}</code></pre></details>

### Schema: ActionResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "oneOf": [
    {
      "type": "object",
      "required": [
        "kind"
      ],
      "properties": {
        "kind": {
          "type": "string",
          "const": "none"
        },
        "feedback": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "kind",
        "text"
      ],
      "properties": {
        "kind": {
          "type": "string",
          "const": "free_text"
        },
        "text": {
          "type": "string"
        },
        "feedback": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "kind",
        "value"
      ],
      "properties": {
        "kind": {
          "type": "string",
          "const": "single_select"
        },
        "feedback": {
          "type": "string"
        },
        "value": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:-]{1,128}$",
          "description": "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "kind",
        "values"
      ],
      "properties": {
        "kind": {
          "type": "string",
          "const": "multi_select"
        },
        "feedback": {
          "type": "string"
        },
        "values": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:-]{1,128}$",
            "description": "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
          }
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "kind",
        "mode",
        "value_date",
        "display_timezone"
      ],
      "properties": {
        "feedback": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "const": "date_picker"
        },
        "mode": {
          "type": "string",
          "const": "date"
        },
        "value_date": {
          "type": "string",
          "format": "date"
        },
        "display_timezone": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "kind",
        "mode",
        "value_utc",
        "display_timezone"
      ],
      "properties": {
        "feedback": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "const": "date_picker"
        },
        "mode": {
          "type": "string",
          "const": "datetime"
        },
        "value_utc": {
          "type": "string",
          "format": "date-time"
        },
        "display_timezone": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "kind",
        "file"
      ],
      "properties": {
        "kind": {
          "type": "string",
          "const": "file_upload"
        },
        "feedback": {
          "type": "string"
        },
        "file": {
          "type": "object",
          "required": [
            "file_id",
            "filename",
            "mime_type",
            "size_bytes",
            "sha256"
          ],
          "properties": {
            "file_id": {
              "type": "string",
              "minLength": 1
            },
            "filename": {
              "type": "string",
              "minLength": 1
            },
            "mime_type": {
              "type": "string",
              "minLength": 1
            },
            "size_bytes": {
              "type": "integer",
              "minimum": 0
            },
            "sha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  ],
  "description": "The human response, with optional feedback accompanying the selected answer. Date-picker responses share a kind and are distinguished by mode."
}</code></pre></details>

### Schema: InputSubmission

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "caller_item_id",
    "row_type",
    "title",
    "subtitle",
    "summary",
    "link_buttons",
    "actions"
  ],
  "properties": {
    "caller_item_id": {
      "type": "string",
      "minLength": 1
    },
    "priority": {
      "oneOf": [
        {
          "oneOf": [
            {
              "type": "string",
              "const": "low"
            },
            {
              "type": "string",
              "const": "normal"
            },
            {
              "type": "string",
              "const": "high"
            },
            {
              "type": "string",
              "const": "urgent"
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "row_type": {
      "type": "object",
      "required": [
        "display",
        "icon"
      ],
      "properties": {
        "display": {
          "type": "string",
          "minLength": 1
        },
        "icon": {
          "$ref": "#/components/schemas/Icon"
        }
      },
      "additionalProperties": true
    },
    "row_accent_color": {
      "oneOf": [
        {
          "type": "string",
          "enum": [
            "red",
            "orange",
            "yellow",
            "green",
            "blue",
            "purple",
            "pink",
            "teal"
          ],
          "description": "A named color from the Agent Outbox product palette."
        },
        {
          "type": "null"
        }
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "subtitle": {
      "type": "string",
      "minLength": 1
    },
    "corner": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "card_time": {
      "oneOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$",
          "description": "Optional caller-owned event time, separate from Outbox creation and update times. UTC only, years 0001–9999, at most millisecond precision. Omission or null clears it on replacement."
        },
        {
          "type": "null"
        }
      ]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "details": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "link_buttons": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "display",
          "icon",
          "url"
        ],
        "properties": {
          "display": {
            "type": "string",
            "minLength": 1
          },
          "icon": {
            "$ref": "#/components/schemas/Icon"
          },
          "url": {
            "type": "string",
            "minLength": 1
          }
        },
        "additionalProperties": true
      },
      "maxItems": 32
    },
    "card_visual": {
      "oneOf": [
        {
          "oneOf": [
            {
              "type": "object",
              "required": [
                "kind",
                "label",
                "value",
                "display",
                "min_value",
                "max_value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "numeric_bar"
                },
                "label": {
                  "type": "string",
                  "minLength": 1
                },
                "value": {
                  "type": "number"
                },
                "display": {
                  "type": "string",
                  "minLength": 1
                },
                "unit": {
                  "oneOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "min_value": {
                  "type": "number"
                },
                "max_value": {
                  "type": "number"
                }
              },
              "additionalProperties": true
            },
            {
              "type": "object",
              "required": [
                "kind",
                "label",
                "value",
                "display",
                "min_value",
                "max_value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "progress_ring"
                },
                "label": {
                  "type": "string",
                  "minLength": 1
                },
                "value": {
                  "type": "number"
                },
                "display": {
                  "type": "string",
                  "minLength": 1
                },
                "unit": {
                  "oneOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "min_value": {
                  "type": "number"
                },
                "max_value": {
                  "type": "number"
                },
                "color": {
                  "oneOf": [
                    {
                      "type": "string",
                      "enum": [
                        "red",
                        "orange",
                        "yellow",
                        "green",
                        "blue",
                        "purple",
                        "pink",
                        "teal"
                      ],
                      "description": "A named color from the Agent Outbox product palette."
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "additionalProperties": true
            },
            {
              "type": "object",
              "required": [
                "kind",
                "text",
                "color"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "pill"
                },
                "text": {
                  "type": "string",
                  "minLength": 1
                },
                "icon": {
                  "oneOf": [
                    {
                      "$ref": "#/components/schemas/Icon"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "color": {
                  "type": "string",
                  "enum": [
                    "red",
                    "orange",
                    "yellow",
                    "green",
                    "blue",
                    "purple",
                    "pink",
                    "teal"
                  ],
                  "description": "A named color from the Agent Outbox product palette."
                }
              },
              "additionalProperties": true
            }
          ],
          "discriminator": {
            "propertyName": "kind"
          }
        },
        {
          "type": "null"
        }
      ]
    },
    "skip_disabled": {
      "oneOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        }
      ]
    },
    "actions": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/InputAction"
      },
      "minItems": 1,
      "maxItems": 32
    }
  },
  "title": "Input submission",
  "description": "A complete, caller-owned review request. The server derives account and caller identity from the bearer credential. Optional fields may be omitted; the server stores and later returns the default-expanded canonical form.",
  "additionalProperties": true
}</code></pre></details>

### Schema: CanonicalRawInput

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "caller_item_id",
    "priority",
    "row_type",
    "row_accent_color",
    "title",
    "subtitle",
    "corner",
    "card_time",
    "summary",
    "details",
    "link_buttons",
    "card_visual",
    "skip_disabled",
    "actions"
  ],
  "properties": {
    "caller_item_id": {
      "type": "string",
      "minLength": 1
    },
    "priority": {
      "oneOf": [
        {
          "type": "string",
          "const": "low"
        },
        {
          "type": "string",
          "const": "normal"
        },
        {
          "type": "string",
          "const": "high"
        },
        {
          "type": "string",
          "const": "urgent"
        }
      ]
    },
    "row_type": {
      "type": "object",
      "required": [
        "display",
        "icon"
      ],
      "properties": {
        "display": {
          "type": "string",
          "minLength": 1
        },
        "icon": {
          "$ref": "#/components/schemas/Icon"
        }
      },
      "additionalProperties": true
    },
    "row_accent_color": {
      "oneOf": [
        {
          "type": "string",
          "enum": [
            "red",
            "orange",
            "yellow",
            "green",
            "blue",
            "purple",
            "pink",
            "teal"
          ],
          "description": "A named color from the Agent Outbox product palette."
        },
        {
          "type": "null"
        }
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "subtitle": {
      "type": "string",
      "minLength": 1
    },
    "corner": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "card_time": {
      "oneOf": [
        {
          "type": "string",
          "format": "date-time"
        },
        {
          "type": "null"
        }
      ]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "details": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "link_buttons": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "display",
          "icon",
          "url"
        ],
        "properties": {
          "display": {
            "type": "string",
            "minLength": 1
          },
          "icon": {
            "$ref": "#/components/schemas/Icon"
          },
          "url": {
            "type": "string",
            "minLength": 1
          }
        },
        "additionalProperties": true
      },
      "maxItems": 32
    },
    "card_visual": {
      "oneOf": [
        {
          "oneOf": [
            {
              "type": "object",
              "required": [
                "kind",
                "label",
                "value",
                "display",
                "min_value",
                "max_value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "numeric_bar"
                },
                "label": {
                  "type": "string",
                  "minLength": 1
                },
                "value": {
                  "type": "number"
                },
                "display": {
                  "type": "string",
                  "minLength": 1
                },
                "unit": {
                  "oneOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "min_value": {
                  "type": "number"
                },
                "max_value": {
                  "type": "number"
                }
              },
              "additionalProperties": true
            },
            {
              "type": "object",
              "required": [
                "kind",
                "label",
                "value",
                "display",
                "min_value",
                "max_value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "progress_ring"
                },
                "label": {
                  "type": "string",
                  "minLength": 1
                },
                "value": {
                  "type": "number"
                },
                "display": {
                  "type": "string",
                  "minLength": 1
                },
                "unit": {
                  "oneOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "min_value": {
                  "type": "number"
                },
                "max_value": {
                  "type": "number"
                },
                "color": {
                  "oneOf": [
                    {
                      "type": "string",
                      "enum": [
                        "red",
                        "orange",
                        "yellow",
                        "green",
                        "blue",
                        "purple",
                        "pink",
                        "teal"
                      ],
                      "description": "A named color from the Agent Outbox product palette."
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "additionalProperties": true
            },
            {
              "type": "object",
              "required": [
                "kind",
                "text",
                "color"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "pill"
                },
                "text": {
                  "type": "string",
                  "minLength": 1
                },
                "icon": {
                  "oneOf": [
                    {
                      "$ref": "#/components/schemas/Icon"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "color": {
                  "type": "string",
                  "enum": [
                    "red",
                    "orange",
                    "yellow",
                    "green",
                    "blue",
                    "purple",
                    "pink",
                    "teal"
                  ],
                  "description": "A named color from the Agent Outbox product palette."
                }
              },
              "additionalProperties": true
            }
          ],
          "discriminator": {
            "propertyName": "kind"
          }
        },
        {
          "type": "null"
        }
      ]
    },
    "skip_disabled": {
      "type": "boolean"
    },
    "actions": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/InputAction"
      },
      "minItems": 1,
      "maxItems": 32
    }
  },
  "title": "Canonical accepted input",
  "description": "The default-expanded submission Agent Outbox accepted and returns as raw_input. Request InputSubmission remains weaker so callers may omit defaults; this response shape always includes them.",
  "additionalProperties": false
}</code></pre></details>

### Schema: InputDelete

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "caller_item_id"
  ],
  "properties": {
    "caller_item_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "title": "Delete pending input",
  "additionalProperties": true
}</code></pre></details>

### Schema: InputReadRequest

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "caller_item_id"
  ],
  "properties": {
    "caller_item_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "title": "Read live input",
  "additionalProperties": true
}</code></pre></details>

### Schema: OutputReadAllRequest

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "properties": {
    "limit": {
      "oneOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 25
        },
        {
          "type": "null"
        }
      ]
    },
    "cursor": {
      "oneOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "title": "Read-all page request",
  "additionalProperties": true
}</code></pre></details>

### Schema: InputSendResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "caller_item_id",
        "status",
        "revision",
        "created",
        "duplicate"
      ],
      "properties": {
        "caller_item_id": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "type": "string",
          "const": "pending"
        },
        "revision": {
          "type": "integer",
          "minimum": 1
        },
        "created": {
          "type": "boolean"
        },
        "duplicate": {
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: InputReplaceResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "caller_item_id",
        "status",
        "revision",
        "replaced",
        "changed"
      ],
      "properties": {
        "caller_item_id": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "type": "string",
          "const": "pending"
        },
        "revision": {
          "type": "integer",
          "minimum": 1
        },
        "replaced": {
          "type": "boolean"
        },
        "changed": {
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: InputDeleteResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "caller_item_id",
        "deleted"
      ],
      "properties": {
        "caller_item_id": {
          "type": "string",
          "minLength": 1
        },
        "deleted": {
          "type": "boolean",
          "const": true
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: InputListResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "items",
        "has_more",
        "next_cursor",
        "returned_count",
        "page_limit"
      ],
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "caller_item_id",
              "status",
              "revision",
              "created_at",
              "updated_at",
              "answered_at"
            ],
            "properties": {
              "caller_item_id": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "oneOf": [
                  {
                    "type": "string",
                    "const": "pending"
                  },
                  {
                    "type": "string",
                    "const": "answered"
                  }
                ]
              },
              "revision": {
                "type": "integer",
                "minimum": 1
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              },
              "answered_at": {
                "oneOf": [
                  {
                    "type": "string",
                    "format": "date-time"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        },
        "has_more": {
          "type": "boolean"
        },
        "next_cursor": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "returned_count": {
          "type": "integer",
          "minimum": 0
        },
        "page_limit": {
          "type": "integer",
          "minimum": 1
        }
      },
      "title": "Input list page",
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: InputReadResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "caller_item_id",
        "status",
        "revision",
        "created_at",
        "updated_at",
        "answered_at",
        "raw_input"
      ],
      "properties": {
        "caller_item_id": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "oneOf": [
            {
              "type": "string",
              "const": "pending"
            },
            {
              "type": "string",
              "const": "answered"
            }
          ]
        },
        "revision": {
          "type": "integer",
          "minimum": 1
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        },
        "updated_at": {
          "type": "string",
          "format": "date-time"
        },
        "answered_at": {
          "oneOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "raw_input": {
          "$ref": "#/components/schemas/CanonicalRawInput"
        }
      },
      "title": "Live input",
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: OutputCheckResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "items",
        "ready_count",
        "has_more",
        "next_cursor",
        "returned_count",
        "page_limit"
      ],
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "output_result_id",
              "caller_item_id",
              "answered_at"
            ],
            "properties": {
              "output_result_id": {
                "type": "string",
                "minLength": 1
              },
              "caller_item_id": {
                "type": "string",
                "minLength": 1
              },
              "answered_at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "additionalProperties": false
          }
        },
        "ready_count": {
          "type": "integer",
          "minimum": 0,
          "description": "Total live results awaiting acknowledgement, including results already read."
        },
        "has_more": {
          "type": "boolean"
        },
        "next_cursor": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "returned_count": {
          "type": "integer",
          "minimum": 0
        },
        "page_limit": {
          "type": "integer",
          "minimum": 1
        }
      },
      "title": "Output readiness page",
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: OutputResultResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "output_result_id",
        "caller_id",
        "caller_item_id",
        "action_value",
        "response",
        "answered_at",
        "answered_by",
        "raw_input"
      ],
      "properties": {
        "output_result_id": {
          "type": "string",
          "minLength": 1
        },
        "caller_id": {
          "type": "string",
          "minLength": 1
        },
        "caller_item_id": {
          "type": "string",
          "minLength": 1
        },
        "action_value": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:-]{1,128}$",
          "description": "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
        },
        "response": {
          "$ref": "#/components/schemas/ActionResponse"
        },
        "answered_at": {
          "type": "string",
          "format": "date-time"
        },
        "answered_by": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "raw_input": {
          "$ref": "#/components/schemas/CanonicalRawInput"
        }
      },
      "title": "Output result",
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: OutputReadPageResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "items",
        "unavailable_outputs",
        "unavailable_count",
        "has_more",
        "next_cursor",
        "returned_count",
        "page_limit"
      ],
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "output_result_id",
              "caller_id",
              "caller_item_id",
              "action_value",
              "response",
              "answered_at",
              "answered_by",
              "raw_input"
            ],
            "properties": {
              "output_result_id": {
                "type": "string",
                "minLength": 1
              },
              "caller_id": {
                "type": "string",
                "minLength": 1
              },
              "caller_item_id": {
                "type": "string",
                "minLength": 1
              },
              "action_value": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:-]{1,128}$",
                "description": "A caller-owned stable value used for programmatic branching. Keep it separate from display text."
              },
              "response": {
                "$ref": "#/components/schemas/ActionResponse"
              },
              "answered_at": {
                "type": "string",
                "format": "date-time"
              },
              "answered_by": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "raw_input": {
                "$ref": "#/components/schemas/CanonicalRawInput"
              }
            },
            "title": "Output result",
            "additionalProperties": false
          }
        },
        "unavailable_outputs": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "output_result_id",
              "code",
              "message"
            ],
            "properties": {
              "output_result_id": {
                "type": "string",
                "minLength": 1
              },
              "code": {
                "type": "string",
                "const": "temporary_unavailable"
              },
              "message": {
                "type": "string",
                "const": "Output file metadata is temporarily unavailable."
              }
            },
            "additionalProperties": false
          }
        },
        "unavailable_count": {
          "type": "integer",
          "minimum": 0
        },
        "has_more": {
          "type": "boolean"
        },
        "next_cursor": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "returned_count": {
          "type": "integer",
          "minimum": 0
        },
        "page_limit": {
          "type": "integer",
          "minimum": 1
        }
      },
      "title": "Output result page",
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: OutputAckResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "output_result_id",
        "acknowledged",
        "already_acknowledged"
      ],
      "properties": {
        "output_result_id": {
          "type": "string",
          "minLength": 1
        },
        "acknowledged": {
          "type": "boolean",
          "const": true
        },
        "already_acknowledged": {
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: CallerStatusResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "caller",
        "account"
      ],
      "properties": {
        "caller": {
          "type": "object",
          "required": [
            "caller_id",
            "caller_slug",
            "display_name",
            "status",
            "key"
          ],
          "properties": {
            "caller_id": {
              "type": "string",
              "minLength": 1
            },
            "caller_slug": {
              "oneOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "display_name": {
              "type": "string",
              "minLength": 1
            },
            "status": {
              "oneOf": [
                {
                  "type": "string",
                  "const": "pending_activation"
                },
                {
                  "type": "string",
                  "const": "active"
                },
                {
                  "type": "string",
                  "const": "revoked"
                },
                {
                  "type": "string",
                  "const": "expired"
                }
              ]
            },
            "key": {
              "type": "object",
              "required": [
                "key_id",
                "prefix",
                "last_chars",
                "created_at",
                "last_used_at"
              ],
              "properties": {
                "key_id": {
                  "type": "string",
                  "minLength": 1
                },
                "prefix": {
                  "type": "string",
                  "minLength": 1
                },
                "last_chars": {
                  "type": "string",
                  "minLength": 1
                },
                "created_at": {
                  "type": "string",
                  "format": "date-time"
                },
                "last_used_at": {
                  "oneOf": [
                    {
                      "type": "string",
                      "format": "date-time"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        },
        "account": {
          "type": "object",
          "required": [
            "account_id",
            "label",
            "tier",
            "effective_tier",
            "billing_status",
            "grace_ends_at",
            "file_upload_enabled",
            "storage",
            "active_limit_blocks"
          ],
          "properties": {
            "account_id": {
              "type": "string",
              "minLength": 1
            },
            "label": {
              "oneOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "tier": {
              "oneOf": [
                {
                  "type": "string",
                  "const": "hosted_free"
                },
                {
                  "type": "string",
                  "const": "hosted_paid"
                },
                {
                  "type": "string",
                  "const": "self_hosted"
                }
              ]
            },
            "effective_tier": {
              "oneOf": [
                {
                  "type": "string",
                  "const": "free"
                },
                {
                  "type": "string",
                  "const": "paid"
                }
              ]
            },
            "billing_status": {
              "oneOf": [
                {
                  "type": "string",
                  "const": "not_applicable"
                },
                {
                  "type": "string",
                  "const": "active"
                },
                {
                  "type": "string",
                  "const": "grace"
                },
                {
                  "type": "string",
                  "const": "past_due"
                },
                {
                  "type": "string",
                  "const": "canceled"
                }
              ]
            },
            "grace_ends_at": {
              "oneOf": [
                {
                  "type": "string",
                  "format": "date-time"
                },
                {
                  "type": "null"
                }
              ]
            },
            "file_upload_enabled": {
              "type": "boolean"
            },
            "storage": {
              "type": "object",
              "required": [
                "stored_bytes",
                "limit_name",
                "limit_bytes"
              ],
              "properties": {
                "stored_bytes": {
                  "type": "integer",
                  "minimum": 0
                },
                "limit_name": {
                  "type": "string",
                  "minLength": 1
                },
                "limit_bytes": {
                  "oneOf": [
                    {
                      "type": "integer",
                      "minimum": 0
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "additionalProperties": false
            },
            "active_limit_blocks": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "operation_kind",
                  "limit_name",
                  "limit_reason_code",
                  "limit_reason",
                  "limit_resets_at",
                  "used_units",
                  "limit_units"
                ],
                "properties": {
                  "operation_kind": {
                    "type": "string",
                    "minLength": 1
                  },
                  "limit_name": {
                    "type": "string",
                    "minLength": 1
                  },
                  "limit_reason_code": {
                    "type": "string",
                    "minLength": 1
                  },
                  "limit_reason": {
                    "type": "string",
                    "minLength": 1
                  },
                  "limit_resets_at": {
                    "oneOf": [
                      {
                        "type": "string",
                        "format": "date-time"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "used_units": {
                    "oneOf": [
                      {
                        "type": "integer",
                        "minimum": 0
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "limit_units": {
                    "oneOf": [
                      {
                        "type": "integer",
                        "minimum": 0
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "additionalProperties": false
              }
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: AccountStatusResponse

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "data"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "required": [
        "account_id",
        "label",
        "tier",
        "effective_tier",
        "billing_status",
        "grace_ends_at",
        "file_upload_enabled",
        "storage",
        "active_limit_blocks"
      ],
      "properties": {
        "account_id": {
          "type": "string",
          "minLength": 1
        },
        "label": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "tier": {
          "oneOf": [
            {
              "type": "string",
              "const": "hosted_free"
            },
            {
              "type": "string",
              "const": "hosted_paid"
            },
            {
              "type": "string",
              "const": "self_hosted"
            }
          ]
        },
        "effective_tier": {
          "oneOf": [
            {
              "type": "string",
              "const": "free"
            },
            {
              "type": "string",
              "const": "paid"
            }
          ]
        },
        "billing_status": {
          "oneOf": [
            {
              "type": "string",
              "const": "not_applicable"
            },
            {
              "type": "string",
              "const": "active"
            },
            {
              "type": "string",
              "const": "grace"
            },
            {
              "type": "string",
              "const": "past_due"
            },
            {
              "type": "string",
              "const": "canceled"
            }
          ]
        },
        "grace_ends_at": {
          "oneOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "file_upload_enabled": {
          "type": "boolean"
        },
        "storage": {
          "type": "object",
          "required": [
            "stored_bytes",
            "limit_name",
            "limit_bytes"
          ],
          "properties": {
            "stored_bytes": {
              "type": "integer",
              "minimum": 0
            },
            "limit_name": {
              "type": "string",
              "minLength": 1
            },
            "limit_bytes": {
              "oneOf": [
                {
                  "type": "integer",
                  "minimum": 0
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "additionalProperties": false
        },
        "active_limit_blocks": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "operation_kind",
              "limit_name",
              "limit_reason_code",
              "limit_reason",
              "limit_resets_at",
              "used_units",
              "limit_units"
            ],
            "properties": {
              "operation_kind": {
                "type": "string",
                "minLength": 1
              },
              "limit_name": {
                "type": "string",
                "minLength": 1
              },
              "limit_reason_code": {
                "type": "string",
                "minLength": 1
              },
              "limit_reason": {
                "type": "string",
                "minLength": 1
              },
              "limit_resets_at": {
                "oneOf": [
                  {
                    "type": "string",
                    "format": "date-time"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "used_units": {
                "oneOf": [
                  {
                    "type": "integer",
                    "minimum": 0
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "limit_units": {
                "oneOf": [
                  {
                    "type": "integer",
                    "minimum": 0
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}</code></pre></details>

### Schema: ErrorEnvelope

<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>{
  "type": "object",
  "required": [
    "ok",
    "request_id",
    "correlation_id",
    "error"
  ],
  "properties": {
    "ok": {
      "type": "boolean",
      "const": false
    },
    "request_id": {
      "type": "string",
      "minLength": 1
    },
    "correlation_id": {
      "type": "string",
      "minLength": 1
    },
    "error": {
      "type": "object",
      "required": [
        "code",
        "message"
      ],
      "properties": {
        "code": {
          "type": "string",
          "enum": [
            "invalid_request",
            "invalid_json",
            "request_too_large",
            "validation_failed",
            "unsupported_icon",
            "unsafe_html",
            "unsafe_color",
            "upgrade_required",
            "retention_limit_exceeded",
            "billing_grace_expired",
            "authentication_required",
            "invalid_caller_credentials",
            "not_found",
            "pending_content_conflict",
            "answered_unacknowledged",
            "input_not_pending",
            "rate_limit_exceeded",
            "quota_limit_exceeded",
            "storage_limit_exceeded",
            "temporary_unavailable",
            "internal_error"
          ]
        },
        "message": {
          "type": "string",
          "minLength": 1
        },
        "fields": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "path",
              "code",
              "message"
            ],
            "properties": {
              "path": {
                "type": "string"
              },
              "code": {
                "type": "string",
                "minLength": 1
              },
              "message": {
                "type": "string",
                "minLength": 1
              }
            },
            "additionalProperties": false
          }
        },
        "retry_after_seconds": {
          "type": "integer",
          "minimum": 0
        },
        "limit": {},
        "upgrade": {},
        "error_id": {
          "type": "string",
          "minLength": 1
        }
      },
      "additionalProperties": true
    }
  },
  "title": "Error response",
  "additionalProperties": false
}</code></pre></details>
