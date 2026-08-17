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

## CLI Exit Codes

The CLI uses BSD `sysexits`-style numeric exits for stable agent branching. `0`
means success. Unknown local failures use `1`. API error codes from the catalog
below map as follows:

| Exit code | Name              | Error codes                                                                                                                                         |
| --------: | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
|        64 | usage             | `invalid_request`, `usage_error`, and local command-line usage errors.                                                                              |
|        65 | data              | `invalid_json`, `request_too_large`, `validation_failed`, `unsupported_icon`, `unsafe_html`, `unsafe_color`, `invalid_action_response`.             |
|        66 | not found         | `not_found`.                                                                                                                                        |
|        69 | unavailable       | `upgrade_required`.                                                                                                                                 |
|        70 | software          | `internal_error`.                                                                                                                                   |
|        73 | conflict          | `caller_already_exists`, `pending_content_conflict`, `answered_unacknowledged`, `input_not_pending`, `stale_input_revision`, `output_already_read`. |
|        74 | secret store      | `secret_store_error`.                                                                                                                               |
|        75 | temporary failure | `rate_limit_exceeded`, `quota_limit_exceeded`, `storage_limit_exceeded`, `authorization_pending`, `temporary_unavailable`.                          |
|        77 | permission        | `authentication_required`, `invalid_caller_credentials`, `authorization_failed`.                                                                    |
|        78 | config            | Local CLI config and caller-selection errors such as `config_error`, `caller_selection_conflict`, `ambiguous_caller`, and `unknown_caller`.         |

## Local CLI Error Codes

These codes are emitted by the local CLI JSON error renderer and do not have an
HTTP status. They use the same envelope shape as API errors.

| Code                        | Exit code | Meaning                                                                                                                                                          |
| --------------------------- | --------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage_error`               |        64 | The local command line is invalid, such as an unknown flag, unknown command, unsupported argument, or wrong argument count.                                      |
| `config_error`              |        78 | Local CLI config, base URL, config path, or non-secret config file contents are missing, unreadable, invalid, or unsupported.                                    |
| `caller_selection_conflict` |        78 | Both `--caller` and `AGENT_OUTBOX_CALLER` were set; the CLI refuses to choose one even when the values match.                                                    |
| `ambiguous_caller`          |        78 | More than one local caller is configured and no explicit caller selector was supplied.                                                                           |
| `unknown_caller`            |        78 | The selected local caller name is absent from the selected config file.                                                                                          |
| `secret_store_error`        |        74 | The local OS credential store or encrypted caller-secret file is unavailable, missing required caller secret material, unreadable, unwritable, or undecryptable. |

## Error Catalog

| Code                         | HTTP status | Meaning                                                                                                                                                                    |
| ---------------------------- | ----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`            |         400 | The request shape, query string, method, or headers are invalid before schema-specific validation.                                                                         |
| `invalid_json`               |         400 | The request body is not valid JSON.                                                                                                                                        |
| `request_too_large`          |         413 | A request exceeds its raw-body cap: 128,000 bytes for API JSON handled by the shared parser and 1,048,576 bytes for Stripe webhooks.                                       |
| `validation_failed`          |         422 | The typed input or output action response failed schema validation.                                                                                                        |
| `unsupported_icon`           |         422 | A submitted icon is not a supported Lucide icon name.                                                                                                                      |
| `unsafe_html`                |         422 | Submitted HTML contains disallowed elements, attributes, URLs, or embedded content.                                                                                        |
| `unsafe_color`               |         422 | A submitted color is not in the supported product-palette allow-list.                                                                                                      |
| `invalid_action_response`    |         422 | A human action response does not match the selected action popup schema.                                                                                                   |
| `upgrade_required`           |         402 | A hosted-free account submitted an input item containing a `file_upload` popup.                                                                                            |
| `authentication_required`    |         401 | No usable bearer credential was supplied.                                                                                                                                  |
| `invalid_caller_credentials` |         401 | The bearer credential is invalid, wrong, revoked, expired, inactive, or otherwise unusable. The client response does not distinguish these states.                         |
| `authorization_failed`       |         403 | The authenticated principal is not allowed to access the requested account, caller, output, or file.                                                                       |
| `not_found`                  |         404 | The requested live resource is absent for the authenticated caller, or the Clerk approval page found no setup request for the signed-in account.                           |
| `caller_already_exists`      |         409 | Caller connect approval targeted a name/slug already used by an existing caller in the account; use caller rotate or choose a different name.                              |
| `pending_content_conflict`   |         409 | `input send` repeated a live pending `caller_item_id` with different normalized content.                                                                                   |
| `answered_unacknowledged`    |         409 | The live item is answered and the matching output result is still unacknowledged.                                                                                          |
| `input_not_pending`          |         409 | Replace or delete targeted an item that is not pending.                                                                                                                    |
| `stale_input_revision`       |         409 | Human answer submission used an older revision than the current pending item.                                                                                              |
| `output_already_read`        |         409 | A pre-read human undo was attempted after caller read disabled undo.                                                                                                       |
| `rate_limit_exceeded`        |         429 | A fixed-window or burst limit blocked the request.                                                                                                                         |
| `quota_limit_exceeded`       |         429 | An account quota or active limit block denied the request.                                                                                                                 |
| `storage_limit_exceeded`     |         429 | A current queue or stored-byte stock limit denied a storage-producing operation.                                                                                           |
| `retention_limit_exceeded`   |         429 | A retention or cleanup limit means a queued item, output, or pending item must be removed or has expired.                                                                  |
| `billing_grace_expired`      |         402 | A paid account's billing or downgrade grace ended; current tier limits apply until billing is restored or cleanup downgrades the account.                                  |
| `authorization_pending`      |         202 | Device-code caller control-plane operation (connect, rotate, or revoke) has not been approved yet; retry after the response's `Retry-After` / `retry_after_seconds` value. |
| `temporary_unavailable`      |         503 | A transient dependency or runtime failure prevented the operation.                                                                                                         |
| `internal_error`             |         500 | Unexpected server error. The response may include `error_id` for support correlation.                                                                                      |

## Leakage Rules

Error payloads, logs, Sentry context, and CLI diagnostics must not include:

- raw review HTML, titles, summaries, details, or full request bodies;
- free-text action responses;
- selected option display text when avoidable;
- file contents or uploaded file names when avoidable;
- caller API keys, local secret-store paths containing secrets, or bearer
  headers;
- Stripe ids or other sensitive provider internals.
