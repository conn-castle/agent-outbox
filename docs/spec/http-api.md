# HTTP API Contract

This document defines the Phase 4 HTTP surface for caller integrations. Schema
details live in [input-schema.md](input-schema.md),
[output-schema.md](output-schema.md), and [errors.md](errors.md).

## Base URL

Hosted caller routes live under the app origin:

```text
https://app.agent-outbox.dev/api
```

Local development uses the configured `APP_BASE_URL` with the same `/api`
routes. The MVP does not use `/api/v1` paths.

## Common Headers

Caller data-plane and caller-authenticated status requests require:

```http
Authorization: Bearer aob_live_<key_id>_<secret>
Accept: application/json
```

JSON request bodies require:

```http
Content-Type: application/json
```

Callers may send `X-Request-ID` with an opaque ASCII request id. The server
generates one when omitted. The server returns `X-Request-ID` and
`X-Correlation-ID` on JSON responses and file-download responses. Rate-limit
responses include `Retry-After` when a retry time is available.

## Caller Authentication

Caller API keys are display-once bearer credentials bound to exactly one
`account_id` and one `caller_id`.

The server derives account and caller identity from the bearer key for every
caller route. Request bodies must not include `caller_id`, and caller-supplied
ids or slugs are never authorization boundaries.

Client-facing credential failures are intentionally generic:

- missing bearer token;
- malformed bearer token;
- unknown key id;
- wrong secret;
- revoked key;
- expired key;
- inactive key.

These cases return a stable authentication error without revealing which
lifecycle state matched. Granular lifecycle details may be logged internally
without secrets or review content.

## JSON Envelopes

All JSON success responses use the shared envelope:

```json
{
  "ok": true,
  "request_id": "req_...",
  "correlation_id": "corr_...",
  "data": {}
}
```

All JSON errors use the envelope in [errors.md](errors.md#error-envelope).
File-download success responses return raw bytes instead of a JSON envelope.

## Input Routes

### Send Input

```http
POST /api/input/send
```

Body: `AgentOutboxInputSubmission`.

Behavior:

- Creates a pending item for the authenticated caller.
- Treats an equivalent pending item with the same `caller_item_id` as a
  duplicate no-op success.
- Fails with `pending_content_conflict` when the same pending `caller_item_id`
  has different normalized content.
- Fails with `answered_unacknowledged` when the live item is answered and its
  output result has not been acknowledged.

Success `data`:

```json
{
  "caller_item_id": "email:thread_123",
  "status": "pending",
  "revision": 1,
  "created": true,
  "duplicate": false
}
```

### Replace Input

```http
POST /api/input/replace
```

Body: `AgentOutboxInputSubmission`.

Behavior:

- Replaces the complete pending item and child rows for the authenticated
  caller.
- Increments `revision` only when normalized content changes.
- May return no-op success for same-content replace.
- Fails when the item is missing, not pending, or answered but unacknowledged.

Success `data`:

```json
{
  "caller_item_id": "email:thread_123",
  "status": "pending",
  "revision": 2,
  "replaced": true,
  "changed": true
}
```

### Delete Pending Input

```http
POST /api/input/delete
```

Body:

```json
{
  "caller_item_id": "email:thread_123"
}
```

Behavior:

- Deletes only the authenticated caller's pending item and child rows.
- Emits the corresponding content-safe audit/accounting events.
- Does not delete answered items or matching output results.
- Does not consume the monthly caller API request quota.
- Uses a JSON body instead of a URL path segment because `caller_item_id` is
  caller-owned string data and is not constrained to URL-safe path syntax.

Success `data`:

```json
{
  "caller_item_id": "email:thread_123",
  "deleted": true
}
```

## Human Answer Boundary

Phase 4 implements human-answer creation as a server-only service with explicit
account and human actor context so queue semantics can be tested before the web
UI exists. The MVP does not expose `app/api/human/*` answer routes in Phase 4.

A production human-answer route belongs to the Phase 5 human review UI unless
the project owner explicitly approves adding that route earlier. If added later,
the route must use Clerk-backed human authentication and Agent Outbox account
membership, not caller API keys.

## Output Routes

### Check Output

```http
GET /api/output/check?limit=25&cursor=<opaque_cursor>
```

Behavior:

- Non-mutating readiness check.
- Returns ready metadata only.
- Does not return `action_value`, response payloads, file metadata, or file
  bytes.
- Does not mark results as read or disable human undo.

Success `data` is the paginated output-check envelope in
[output-schema.md](output-schema.md#output-check-page).

### Read One Output

```http
POST /api/output/{output_result_id}/read
```

Behavior:

- Returns the full output result payload for the authenticated caller.
- Marks that output result as read when the response succeeds.
- Disables human undo for that result.
- May return the same result repeatedly until acknowledgement.

Success `data` is `AgentOutboxOutputResult`.

### Read All Output

```http
POST /api/output/read-all
```

Body:

```json
{
  "limit": 25,
  "cursor": null
}
```

Behavior:

- Returns a cursor-paginated page of full output payloads.
- Marks only returned results as read.
- Uses the same ordering and pagination rules as output check.

Success `data` is the paginated output-read envelope in
[output-schema.md](output-schema.md#output-read-page).

### Acknowledge Output

```http
POST /api/output/{output_result_id}/ack
```

Behavior:

- Idempotently acknowledges the authenticated caller's output result.
- Deletes the output result, attached output-file rows/bytes, and matching input
  item in one logical operation.
- Recognizes duplicate acknowledgements through retained audit metadata after
  the live output row is gone.
- Returns not found for an id that was never known for the authenticated caller.
- Does not consume the monthly caller API request quota.

Success `data`:

```json
{
  "output_result_id": "out_123",
  "acknowledged": true,
  "already_acknowledged": false
}
```

Duplicate acknowledgement success sets `already_acknowledged` to `true`.

### Download Output File

```http
GET /api/output/{output_result_id}/files/{file_id}
```

Behavior:

- Validates that the output result and file belong to the account and caller
  derived from the bearer key.
- Rejects access after acknowledgement, retention deletion, or timeout cleanup.
- Returns raw bytes, not a JSON envelope, on success.
- Emits a durable byte-counted file-download audit event.

Required success headers:

```http
Content-Disposition: attachment; filename="<sanitized filename>"
Content-Type: application/octet-stream
X-Content-Type-Options: nosniff
X-Request-ID: req_...
X-Correlation-ID: corr_...
```

The stored MIME type is advisory. Missing or unsafe MIME types return
`application/octet-stream`.

## Status Routes

### Caller Status

```http
GET /api/caller/status
```

Uses caller bearer authentication. Returns selected caller health plus
non-sensitive account, tier, storage, quota, and active-limit status.

Success `data`:

```json
{
  "caller": {
    "caller_id": "caller_123",
    "caller_slug": "steward-email",
    "display_name": "steward-email",
    "status": "active",
    "key": {
      "key_id": "key_123",
      "prefix": "aob_live",
      "last_chars": "abcd",
      "created_at": "2026-06-30T20:00:00Z",
      "last_used_at": "2026-06-30T20:05:00Z"
    }
  },
  "account": {
    "account_id": "acct_123",
    "label": "Nick's Agent Outbox",
    "tier": "hosted_free",
    "effective_tier": "free",
    "billing_status": "not_applicable",
    "grace_ends_at": null,
    "file_upload_enabled": false,
    "storage": {
      "stored_bytes": 0,
      "limit_name": "stored_non_file_queue_payload_bytes",
      "limit_bytes": 32000000
    },
    "active_limit_blocks": []
  }
}
```

Status responses must not expose caller API keys, Stripe ids, full request
bodies, or review content.

### Account Status

```http
GET /api/account/status
```

When called with caller credentials, returns the same non-sensitive account
status object for the bearer key's account. It exists so
`agent-outbox account status` does not require callers to think in caller-scoped
terms when local caller credentials are already available.

If no local caller credential is available, the CLI may use a human-approved
control-plane flow in a later package. That fallback is not a caller-bearer
data-plane request.

## Caller Registration Contract

Caller registration is human-approved control plane, not unauthenticated
self-service and not caller-key self-administration. Full CLI implementation is
owned by the CLI phase, but the HTTP contract is:

### Browser Connect Start

```http
POST /api/caller/connect/browser/start
```

Body:

```json
{
  "local_caller_name": "steward-email",
  "display_name": "steward-email",
  "callback_url": "http://127.0.0.1:49152/callback"
}
```

Success `data`:

```json
{
  "approval_url": "https://app.agent-outbox.dev/caller/connect/approve?...",
  "setup_request_id": "setup_123",
  "expires_at": "2026-06-30T20:10:00Z"
}
```

The human signs in with Clerk, approves the account binding, and the browser
returns a one-time `setup_code` to the local callback.

### Device Connect Start

```http
POST /api/caller/connect/device/start
```

Body:

```json
{
  "local_caller_name": "steward-email",
  "display_name": "steward-email"
}
```

Success `data`:

```json
{
  "device_code": "dev_123",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://app.agent-outbox.dev/caller/connect/device",
  "verification_uri_complete": "https://app.agent-outbox.dev/caller/connect/device?user_code=ABCD-EFGH",
  "expires_at": "2026-06-30T20:10:00Z",
  "poll_interval_seconds": 5
}
```

### Device Connect Poll

```http
POST /api/caller/connect/device/poll
```

Body:

```json
{
  "device_code": "dev_123"
}
```

Pending approval returns `202` with `authorization_pending`. Successful approval
returns the display-once credential response below.

### Connect Exchange

```http
POST /api/caller/connect/exchange
```

Body:

```json
{
  "setup_code": "setup_code_123"
}
```

Success `data`:

```json
{
  "caller": {
    "caller_id": "caller_123",
    "caller_slug": "steward-email",
    "display_name": "steward-email"
  },
  "account": {
    "account_id": "acct_123",
    "label": "Nick's Agent Outbox",
    "effective_tier": "free"
  },
  "credential": {
    "api_key": "aob_live_keyid_secret",
    "key_id": "key_123",
    "prefix": "aob_live",
    "last_chars": "abcd",
    "created_at": "2026-06-30T20:00:00Z"
  }
}
```

`credential.api_key` is display-once. The server stores only the non-secret key
id, keyed hash, and non-secret metadata. Caller-authenticated API keys cannot
rotate or revoke themselves; those operations must use human-approved control
plane flows.

### Caller List Contract

```http
POST /api/caller/list
```

Caller listing is a human-approved control-plane operation used when local CLI
config is insufficient. It returns non-secret caller records for the approved
account:

```json
{
  "callers": [
    {
      "caller_id": "caller_123",
      "caller_slug": "steward-email",
      "display_name": "steward-email",
      "status": "active",
      "created_at": "2026-06-30T20:00:00Z"
    }
  ]
}
```

### Caller Rotate Contract

Rotation uses the same human-approved browser or device-code setup pattern as
connect. Caller API keys cannot rotate themselves.

```http
POST /api/caller/rotate/browser/start
POST /api/caller/rotate/device/start
POST /api/caller/rotate/device/poll
POST /api/caller/rotate/exchange
POST /api/caller/rotate/activate
POST /api/caller/rotate/abort
```

The exchange response returns a pending display-once replacement credential. The
CLI stores that secret locally, then calls `activate`. The server activates the
new key and revokes the old key only after local storage succeeds. Pending
replacement keys expire quickly and cannot authenticate caller data-plane
requests before activation.

### Caller Revoke Contract

```http
POST /api/caller/revoke/browser/start
POST /api/caller/revoke/device/start
POST /api/caller/revoke/device/poll
POST /api/caller/revoke/confirm
```

Revocation is human-approved and revokes active hosted keys for the selected
caller while preserving caller history, queue rows, logs, limits, and audit
metadata. A stolen caller key cannot revoke itself or other keys.

### Caller Disconnect Contract

`agent-outbox caller disconnect` is local-only by default and has no HTTP
request. `agent-outbox caller disconnect --revoke` first runs the caller revoke
contract above, then deletes local config and local secret-store entries after
server confirmation.
