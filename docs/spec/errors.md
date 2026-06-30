# API Errors

Agent Outbox uses one typed error model for HTTP API errors and CLI JSON errors.
The CLI maps these codes to documented nonzero exit codes and keeps stdout
reserved for command results.

## Request And Correlation IDs

Every JSON response includes:

- `request_id`: caller-supplied safe `X-Request-ID` or a generated id;
- `correlation_id`: server-generated id used to join logs, Sentry, and support
  records.

Every response also returns `X-Request-ID` and `X-Correlation-ID` headers.
Unexpected internal errors may include an `error_id` in the error body and
structured logs. Error ids must not encode review content or secrets.

## Success Envelope

```json
{
  "ok": true,
  "request_id": "req_123",
  "correlation_id": "corr_123",
  "data": {}
}
```

## Error Envelope

```json
{
  "ok": false,
  "request_id": "req_123",
  "correlation_id": "corr_123",
  "error": {
    "code": "validation_failed",
    "message": "Input submission failed validation.",
    "fields": [
      {
        "path": "actions[0].value",
        "code": "invalid_action_value",
        "message": "Action values must match [A-Za-z0-9._:-]+."
      }
    ],
    "retry_after_seconds": null,
    "limit": null,
    "upgrade": null,
    "error_id": null
  }
}
```

`fields`, `retry_after_seconds`, `limit`, `upgrade`, and `error_id` are omitted
or null when not relevant.

Field-error paths are stable enough for agents to point at invalid input, but
they must not echo raw HTML, free-text answers, file contents, caller API keys,
or full request bodies.

## Limit Metadata

Rate-limit and quota errors include limit metadata when available:

```json
{
  "limit_name": "authenticated_caller_api_requests_per_calendar_month",
  "limit_reason_code": "monthly_caller_api_quota_exceeded",
  "limit_reason": "Monthly caller API request limit reached; cleanup operations remain available.",
  "limit_resets_at": "2026-07-01T00:00:00Z"
}
```

HTTP `429` responses include `Retry-After` when the retry time is known.

## Upgrade Metadata

A hosted-free input submission that contains a `file_upload` popup returns
`upgrade_required` with `limit_reason_code: file_upload_upgrade_required`, not a
generic validation or quota error.

```json
{
  "message": "File upload actions require a paid hosted account.",
  "url": "https://app.agent-outbox.dev/upgrade"
}
```

The CLI displays the message and may open the URL for `agent-outbox upgrade`.

## Error Catalog

| Code                         | HTTP status | Meaning                                                                                                                                            |
| ---------------------------- | ----------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`            |         400 | The request shape, query string, method, or headers are invalid before schema-specific validation.                                                 |
| `invalid_json`               |         400 | The request body is not valid JSON.                                                                                                                |
| `request_too_large`          |         413 | The non-file request body exceeds the 128,000-byte cap.                                                                                            |
| `validation_failed`          |         422 | The typed input or output action response failed schema validation.                                                                                |
| `unsupported_icon`           |         422 | A submitted icon is not a supported Lucide icon name.                                                                                              |
| `unsafe_html`                |         422 | Submitted HTML contains disallowed elements, attributes, URLs, or embedded content.                                                                |
| `unsafe_color`               |         422 | A submitted color contains unsupported or unsafe CSS syntax.                                                                                       |
| `invalid_action_response`    |         422 | A human action response does not match the selected action popup schema.                                                                           |
| `upgrade_required`           |         402 | A hosted-free account submitted an input item containing a `file_upload` popup.                                                                    |
| `authentication_required`    |         401 | No usable bearer credential was supplied.                                                                                                          |
| `invalid_caller_credentials` |         401 | The bearer credential is invalid, wrong, revoked, expired, inactive, or otherwise unusable. The client response does not distinguish these states. |
| `authorization_failed`       |         403 | The authenticated principal is not allowed to access the requested account, caller, output, or file.                                               |
| `not_found`                  |         404 | The requested live resource is absent for the authenticated caller.                                                                                |
| `already_acknowledged`       |         200 | Duplicate acknowledgement was recognized as a no-op success through retained audit metadata.                                                       |
| `pending_content_conflict`   |         409 | `input send` repeated a live pending `caller_item_id` with different normalized content.                                                           |
| `answered_unacknowledged`    |         409 | The live item is answered and the matching output result is still unacknowledged.                                                                  |
| `input_not_pending`          |         409 | Replace or delete targeted an item that is not pending.                                                                                            |
| `stale_input_revision`       |         409 | Human answer submission used an older revision than the current pending item.                                                                      |
| `output_already_read`        |         409 | A pre-read human undo was attempted after caller read disabled undo.                                                                               |
| `rate_limit_exceeded`        |         429 | A fixed-window or burst limit blocked the request.                                                                                                 |
| `quota_limit_exceeded`       |         429 | An account quota or active limit block denied the request.                                                                                         |
| `storage_limit_exceeded`     |         429 | A current queue or stored-byte stock limit denied a storage-producing operation.                                                                   |
| `authorization_pending`      |         202 | Device-code caller connection has not been approved yet.                                                                                           |
| `temporary_unavailable`      |         503 | A transient dependency or runtime failure prevented the operation.                                                                                 |
| `internal_error`             |         500 | Unexpected server error. The response may include `error_id` for support correlation.                                                              |

## Leakage Rules

Error payloads, logs, Sentry context, and CLI diagnostics must not include:

- raw review HTML, titles, summaries, details, or full request bodies;
- free-text action responses;
- selected option display text when avoidable;
- file contents or uploaded file names when avoidable;
- caller API keys, local secret-store paths containing secrets, or bearer
  headers;
- Stripe ids or other sensitive provider internals.
