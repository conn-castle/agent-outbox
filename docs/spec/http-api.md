# HTTP API Contract

This document defines the implemented HTTP surface for caller integrations:
caller/account status, input writes, output reads, output acknowledgement,
output-file download, human-approved caller connect, rotation, revocation,
disconnect-with-revoke control-plane contracts, and account-scoped billing
checkout/portal/webhook contracts. Schema details live in
[input-schema.md](input-schema.md), [output-schema.md](output-schema.md), and
[errors.md](errors.md). The CLI `upgrade` command is local-only: it opens the
selected app origin plus `/upgrade`.

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

## Billing Routes

Billing routes are account-scoped and use Clerk-backed human account membership
except for Stripe webhooks. Responses and logs must not expose Stripe customer,
subscription, price, payment method, invoice, or raw event payload data.

### Create Checkout Session

```http
POST /api/billing/checkout
```

Behavior:

- Requires a signed-in human with Agent Outbox account membership.
- Creates a Stripe Checkout subscription session for the initial hosted paid
  tier using the requested billing interval.
- Requires a JSON body with `interval` set to `monthly` for `$5/mo` checkout or
  `yearly` for `$50/year` checkout; empty or malformed JSON returns
  `invalid_json`, oversized JSON returns `request_too_large`, and valid JSON
  with a missing interval, non-object body, or unsupported interval returns
  `invalid_request`.
- Uses the Agent Outbox account id as Stripe checkout metadata so webhook events
  can synchronize app billing state.
- Returns a hosted Stripe URL; callers and CLI commands do not receive Stripe
  ids.

Body:

```json
{
  "interval": "monthly"
}
```

Success `data`:

```json
{
  "url": "https://checkout.stripe.com/..."
}
```

### Create Billing Portal Session

```http
POST /api/billing/portal
```

Behavior:

- Requires a signed-in human with Agent Outbox account membership.
- Requires the account to already have a Stripe customer id from checkout or a
  webhook-synchronized subscription.
- Creates a Stripe Billing Portal session and returns only the hosted Stripe
  URL.

Success `data`:

```json
{
  "url": "https://billing.stripe.com/..."
}
```

### Stripe Webhook

```http
POST /api/billing/webhook
```

Behavior:

- Verifies the raw request body with the configured Stripe webhook signing
  secret.
- Does not use Clerk or caller credentials.
- Stores only webhook event id, event type, processing status, timestamps, and
  optional account linkage for idempotency.
- Synchronizes account tier, billing status, grace end, and Stripe lookup ids
  from checkout, subscription, and payment-failure events.
- Treats replayed event ids as already processed.

Success `data`:

```json
{
  "processed": true
}
```

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

Successful output route responses include `Cache-Control: no-store`. Read
responses can contain human-provided answers, file metadata, or raw file bytes
and must not be cached.

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
- Marks only returned `items` as read.
- Uses the same ordering and pagination rules as output check.
- Adds top-level `unavailable_outputs` and `unavailable_count` when a scanned
  file-upload row cannot materialize safe metadata; unavailable entries do not
  include filenames, MIME types, bytes, caller content, or raw payloads.

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
Content-Type: <safe stored MIME type or application/octet-stream>
Cache-Control: no-store
X-Content-Type-Options: nosniff
X-Request-ID: req_...
X-Correlation-ID: corr_...
```

The stored MIME type is advisory. Safe stored MIME types may be returned as the
download `Content-Type`; missing or unsafe MIME types return
`application/octet-stream`.

## Status Routes

### Caller Status

```http
GET /api/caller/status
```

Uses caller bearer authentication. Returns selected caller health plus
non-sensitive account, tier, storage, quota, and active-limit status.
`last_used_at` is coarse operational metadata and may lag a valid caller request
by up to the database freshness window of 15 minutes.

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

If no local caller credential is available, the CLI fails loudly with setup
remediation such as `agent-outbox caller connect <caller>`. There is no
browser/device-code fallback for `account status`.

## Caller Connect Control Plane

Caller connect is a human-approved control plane, not unauthenticated
self-service and not caller-key self-administration. Connect start, device-poll,
and exchange routes are unauthenticated so a new local caller can complete
setup; connect activate and abort require the pending connect key returned by
exchange as the bearer credential. All are protected by DB-backed per-IP
fixed-window limits: `caller_connect_start_requests_per_ip_per_minute`,
`caller_connect_poll_requests_per_ip_per_minute`,
`caller_connect_exchange_requests_per_ip_per_minute`, and
`caller_connect_activation_requests_per_ip_per_minute` each allow 30 requests
per trusted client IP per UTC minute, with the activation limit shared by both
the activate and abort routes. Human approval actions are protected by the
account-scoped `caller_connect_approvals_per_account_per_minute` fixed window,
allowing 30 connect approvals per account per UTC minute through the shared
account quota and active limit-block tables.

For the hosted Cloudflare/OpenNext path, trusted client IP means a valid
`CF-Connecting-IP` header. `X-Forwarded-For` is not trusted for hosted per-IP
control-plane limits; if `CF-Connecting-IP` is missing or invalid, the route
fails loudly with `temporary_unavailable` before rate-limit accounting or setup
state changes.

Connect uses standards-derived OAuth/device-flow timing:

- Browser setup codes are single-use and expire after 10 minutes, matching RFC
  6749's recommended maximum authorization-code lifetime.
- Device codes and user codes expire after 10 minutes.
- Device polling returns `poll_interval_seconds: 5`; pending poll responses
  return `authorization_pending` with `Retry-After: 5`.

Setup, device, user, and browser exchange codes are display-once or client-held
values. The server stores keyed HMAC-SHA256 digests only, using the same server
secret family as caller API key hashing. Setup request rows are transient:
cleanup prunes terminal rows and long-expired pending or approved rows after 7
days, while preserving rotate rows referenced by pending replacement
credentials. Never-activated connect callers with no audit, input, or output
history are reclaimed after the same 7-day window, including their dependent
setup and credential rows.

Approval rejects with `409 caller_already_exists` if the approving account
already has a caller using the requested name/slug. Duplicate connect is not
treated as rotate, does not reuse the existing caller, and does not auto-rename;
the user should run caller rotate or choose a different name.

### Browser Connect Start

Starts a browser approval flow. The human signs in with Clerk, approves the
account binding, and the approval page returns a one-time `setup_code` to the
local callback.

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
returns the display-once pending credential response documented under Connect
Exchange below and marks the device code used. Repeating the same device-code
poll after success does not replay the credential.

### Connect Exchange

Connect uses a two-phase credential handoff mirroring caller rotation. Exchange
creates a pending display-once credential with status `pending_activation`; the
pending key cannot authenticate data-plane routes. The CLI stores the new key
locally, then calls `activate` using the pending key as the bearer credential.
Only activation marks the key active. If local storage fails, the CLI calls
`abort` using the pending key as the bearer credential, leaving no active hosted
key for the caller. Pending connect keys expire at the setup request expiry.

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
  "setup_request_id": "setup_123",
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
    "created_at": "2026-06-30T20:00:00Z",
    "expires_at": "2026-06-30T20:10:00Z"
  }
}
```

`credential.api_key` is display-once. The server stores only the non-secret key
id, keyed hash, and non-secret metadata. The returned key remains
`pending_activation` and cannot authenticate normal caller API requests until
`activate` succeeds. Callers pass `setup_request_id` back to the activate and
abort routes. Caller-authenticated API keys cannot rotate or revoke themselves;
those operations must use human-approved control plane flows.

### Connect Activate

```http
POST /api/caller/connect/activate
```

Requires `Authorization: Bearer aob_live_keyid_secret` using the pending
credential returned by connect exchange.

Body:

```json
{
  "setup_request_id": "setup_123"
}
```

Success `data`:

```json
{
  "caller_id": "caller_123",
  "activated_key_id": "key_123",
  "activated_at": "2026-06-30T20:01:00Z"
}
```

Activation marks the pending key active. Unlike rotate, connect has no prior
active key, so no key is revoked.

### Connect Abort

```http
POST /api/caller/connect/abort
```

Requires `Authorization: Bearer aob_live_keyid_secret` using the pending
credential returned by connect exchange.

Body:

```json
{
  "setup_request_id": "setup_123"
}
```

Success `data`:

```json
{
  "caller_id": "caller_123",
  "aborted_key_id": "key_123",
  "aborted_at": "2026-06-30T20:01:00Z"
}
```

Abort expires the pending key. Because connect has no prior active key, no
active hosted key remains for the caller.

### Connect Errors

Connect routes use the standard error envelope. Common errors:

| Code                         | Status | Applies to                                                                                                                                 |
| ---------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid_request`            |    400 | Malformed request body, invalid/expired/already-used setup or device code, or a non-pending approval target.                               |
| `validation_failed`          |    422 | Missing or invalid fields such as `local_caller_name`, `display_name`, `callback_url`, `device_code`, `setup_code`, or `setup_request_id`. |
| `authentication_required`    |    401 | Missing pending connect bearer key on connect activate/abort.                                                                              |
| `invalid_caller_credentials` |    401 | Pending connect bearer key is invalid, expired, revoked, already active, or not the pending key bound to the supplied `setup_request_id`.  |
| `caller_already_exists`      |    409 | Approval targeted a name/slug already used by a caller in the account; use caller rotate or choose a different name.                       |
| `authorization_pending`      |    202 | Device poll before human approval; clients must honor `Retry-After`.                                                                       |
| `not_found`                  |    404 | Approval page cannot find a connect setup request for the signed-in human's account.                                                       |
| `rate_limit_exceeded`        |    429 | DB-backed per-IP or per-account fixed-window abuse controls deny the operation.                                                            |
| `temporary_unavailable`      |    503 | Required configuration, database state, or transaction processing is unavailable.                                                          |

## Caller Credential Operations Control Plane

Caller rotation, revocation, and disconnect-with-revoke are human-approved
control-plane operations. They are not caller-key data-plane requests, do not
consume monthly caller API quota, and cannot be authorized by an existing active
caller key alone. Browser/device start, device-poll, exchange, confirm,
activate, and abort routes are protected by DB-backed fixed-window limits using
the trusted client IP. Approval actions are protected by distinct account-scoped
`caller_rotate_approvals_per_account_per_minute` and
`caller_revoke_approvals_per_account_per_minute` fixed windows, each allowing 30
approvals per account per UTC minute through the shared account quota and active
limit-block tables. Approval pages are Clerk-authenticated and enforce account
membership before binding the requested operation to an account.

For hosted control-plane IP limits, trusted client IP uses the same
Cloudflare-only policy as connect: a valid `CF-Connecting-IP` header is
required, and `X-Forwarded-For` is not accepted as a fallback.

The CLI identifies the selected existing caller from local non-secret config and
sends its opaque `caller_id` to the start route. The approval page loads caller
metadata from the signed-in human's account; it does not trust caller display
metadata from the unauthenticated start request. There is no
`POST /api/caller/list`; `agent-outbox caller list` is local-only.

### Caller Rotate Contract

Rotation uses the same human-approved browser or device-code setup pattern as
connect. Caller API keys cannot rotate themselves. Exchange creates a pending
display-once replacement credential with status `pending_activation`; the
pending key cannot authenticate data-plane routes. The CLI stores the new key
locally, then calls `activate` using the pending key as the bearer credential.
Only activation marks the new key active and revokes the previous active key. If
local storage fails, the CLI calls `abort` using the pending key as the bearer
credential; the old key stays active. Pending replacement keys expire at the
setup request expiry.

#### Browser Rotate Start

```http
POST /api/caller/rotate/browser/start
```

Body:

```json
{
  "caller_id": "caller_123",
  "local_caller_name": "steward-email",
  "callback_url": "http://127.0.0.1:49152/callback"
}
```

Success `data`:

```json
{
  "approval_url": "https://app.agent-outbox.dev/caller/rotate/approve?...",
  "setup_request_id": "setup_123",
  "expires_at": "2026-06-30T20:10:00Z"
}
```

The approval page redirects to `callback_url` with `status=approved`,
`setup_request_id`, and a display-once `setup_code`.

#### Device Rotate Start

```http
POST /api/caller/rotate/device/start
```

Body:

```json
{
  "caller_id": "caller_123",
  "local_caller_name": "steward-email"
}
```

Success `data`:

```json
{
  "device_code": "dev_123",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://app.agent-outbox.dev/caller/rotate/device",
  "verification_uri_complete": "https://app.agent-outbox.dev/caller/rotate/device?user_code=ABCD-EFGH",
  "expires_at": "2026-06-30T20:10:00Z",
  "poll_interval_seconds": 5
}
```

#### Device Rotate Poll

```http
POST /api/caller/rotate/device/poll
```

Body:

```json
{
  "device_code": "dev_123"
}
```

Pending approval returns `202` with `authorization_pending` and
`Retry-After: 5`. Successful approval returns:

```json
{
  "setup_request_id": "setup_123",
  "setup_code": "setup_code_123",
  "expires_at": "2026-06-30T20:10:00Z"
}
```

The device poll response does not create or activate a replacement credential.
Repeating the same device poll after the setup code has been delivered does not
replay the setup code.

#### Rotate Exchange

```http
POST /api/caller/rotate/exchange
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
    "display_name": "Steward Email"
  },
  "account": {
    "account_id": "acct_123",
    "label": "Nick's Agent Outbox",
    "effective_tier": "free"
  },
  "replacement_credential": {
    "api_key": "aob_live_newkeyid_secret",
    "key_id": "newkeyid",
    "prefix": "aob_live",
    "last_chars": "wxyz",
    "created_at": "2026-06-30T20:00:00Z",
    "expires_at": "2026-06-30T20:10:00Z"
  },
  "replaces_credential": {
    "key_id": "oldkeyid",
    "last_chars": "abcd"
  }
}
```

`replacement_credential.api_key` is display-once. The server stores only the
non-secret key id, keyed hash, and non-secret metadata. The returned key remains
`pending_activation` until `activate` succeeds.

#### Rotate Activate

```http
POST /api/caller/rotate/activate
```

Requires `Authorization: Bearer aob_live_newkeyid_secret` using the pending
replacement key returned by rotate exchange.

Body:

```json
{
  "setup_request_id": "setup_123"
}
```

Success `data`:

```json
{
  "caller_id": "caller_123",
  "activated_key_id": "newkeyid",
  "revoked_key_id": "oldkeyid",
  "activated_at": "2026-06-30T20:01:00Z"
}
```

#### Rotate Abort

```http
POST /api/caller/rotate/abort
```

Requires `Authorization: Bearer aob_live_newkeyid_secret` using the pending
replacement key returned by rotate exchange.

Body:

```json
{
  "setup_request_id": "setup_123"
}
```

Success `data`:

```json
{
  "caller_id": "caller_123",
  "aborted_key_id": "newkeyid",
  "active_key_id": "oldkeyid",
  "aborted_at": "2026-06-30T20:01:00Z"
}
```

### Caller Revoke Contract

Revocation is human-approved and revokes active hosted keys for the selected
caller while preserving caller history, queue rows, logs, limits, and audit
metadata. A stolen caller key cannot revoke itself or other keys.

#### Browser Revoke Start

```http
POST /api/caller/revoke/browser/start
```

Body:

```json
{
  "caller_id": "caller_123",
  "local_caller_name": "steward-email",
  "callback_url": "http://127.0.0.1:49152/callback"
}
```

Success `data`:

```json
{
  "approval_url": "https://app.agent-outbox.dev/caller/revoke/approve?...",
  "setup_request_id": "setup_123",
  "expires_at": "2026-06-30T20:10:00Z"
}
```

The approval page redirects to `callback_url` with `status=approved`,
`setup_request_id`, and a display-once `setup_code`.

#### Device Revoke Start

```http
POST /api/caller/revoke/device/start
```

Body:

```json
{
  "caller_id": "caller_123",
  "local_caller_name": "steward-email"
}
```

Success `data`:

```json
{
  "device_code": "dev_123",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://app.agent-outbox.dev/caller/revoke/device",
  "verification_uri_complete": "https://app.agent-outbox.dev/caller/revoke/device?user_code=ABCD-EFGH",
  "expires_at": "2026-06-30T20:10:00Z",
  "poll_interval_seconds": 5
}
```

#### Device Revoke Poll

```http
POST /api/caller/revoke/device/poll
```

Body:

```json
{
  "device_code": "dev_123"
}
```

Pending approval returns `202` with `authorization_pending` and
`Retry-After: 5`. Successful approval returns:

```json
{
  "setup_request_id": "setup_123",
  "setup_code": "setup_code_123",
  "expires_at": "2026-06-30T20:10:00Z"
}
```

The device poll response does not revoke credentials. Repeating the same device
poll after the setup code has been delivered does not replay the setup code.

#### Revoke Confirm

```http
POST /api/caller/revoke/confirm
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
  "caller_id": "caller_123",
  "revoked_key_ids": ["keyid_1", "keyid_2"],
  "revoked_at": "2026-06-30T20:01:00Z"
}
```

`revoked_key_ids` includes active credentials revoked by this confirmation.
Already-revoked, expired, and pending replacement credentials are not
re-revoked.

### Rotate/Revoke Errors

Rotate and revoke routes use the standard error envelope. Common errors:

| Code                         | Status | Applies to                                                                                                                                                                                 |
| ---------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid_request`            |    400 | Malformed request body, invalid/expired setup or device code, non-pending approval, repeated device-poll setup-code delivery, or activation/abort for the wrong setup request.             |
| `validation_failed`          |    422 | Missing or invalid fields such as `caller_id`, `local_caller_name`, `callback_url`, `device_code`, `setup_code`, or `setup_request_id`.                                                    |
| `authentication_required`    |    401 | Missing pending replacement bearer key on rotate activate/abort.                                                                                                                           |
| `invalid_caller_credentials` |    401 | Pending replacement bearer key is invalid, expired (including expired pending replacement activate/abort requests), revoked, already active, or not the key produced by the setup request. |
| `authorization_pending`      |    202 | Device poll before human approval; clients must honor `Retry-After`.                                                                                                                       |
| `not_found`                  |    404 | Approval page cannot find a setup request for the signed-in human's account.                                                                                                               |
| `rate_limit_exceeded`        |    429 | DB-backed fixed-window abuse controls deny the operation.                                                                                                                                  |
| `temporary_unavailable`      |    503 | Required configuration, database state, or transaction processing is unavailable.                                                                                                          |

### Caller Disconnect Contract

`agent-outbox caller disconnect` is local-only by default and has no HTTP
request. `agent-outbox caller disconnect --revoke` first runs the caller revoke
contract above, then deletes local config and local secret-store entries after
server confirmation.
