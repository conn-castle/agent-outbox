# Ship a reliable integration

The API is designed for agents and workers that stop, restart, retry, and
resume. Reliability comes from preserving the identity and ordering boundaries
in the protocol—not from assuming every request runs once.

## Keep credentials out of agent context

When the supported Agent Outbox CLI distribution is available, prefer its secure
local credential storage. For a raw HTTP integration, inject the bearer
credential at the network boundary. Never place it in source control, request
JSON, logs, tracing attributes, or model prompts.

Each credential is scoped to one caller and account. Use separate callers when
services need independent identity, revocation, or audit history.

## Make send retries deterministic

Build `caller_item_id` from the logical work item and reuse it across transport
retries. A repeated send with equivalent normalized content is a success. A
different request under the same pending id returns a conflict instead of
silently changing the review.

If the pending content truly changed, call `input/replace` with the complete new
request.

## Poll with restraint

`output/check` is non-mutating and cursor-paginated. Poll when the caller can
actually resume work, use backoff and jitter for recurring workers, and obey
`Retry-After` when present. `input/list` uses the same page default and maximum
and is also non-mutating metadata. `input/list` and `input/read` share the
`output_check_read` per-minute limit and consume monthly API request quota.

Full `output/read-all` pages include every matching canonical input. Choose a
smaller `limit` when submissions are large so workers do not need to buffer an
unnecessarily large response.

Do not assume the first page represents the entire queue. Continue with the
opaque `next_cursor` while `has_more` is true. Never inspect or construct a
cursor yourself.

## Drain ready work in batches

Use `output/read-all` when a worker is ready to process a page of complete
decisions. It uses the same opaque cursor model as check and marks only returned
items read.

<!-- contract-example:OutputReadAllRequest -->

```json
{ "limit": 25, "cursor": null }
```

Apply the durable-handling sequence below to each `output_result_id`, then
acknowledge each result individually. If a page reports `unavailable_outputs`,
retry those ids later; they were not marked read.

## Separate read from acknowledgement

Reading crosses a meaningful boundary: the first successful read disables the
person’s undo. It does not remove the result.

Use this order:

1. Read the result.
2. Check whether `output_result_id` has already been handled.
3. Perform or durably record the downstream work.
4. Commit that work.
5. Acknowledge the result.

If the worker stops before step 5, the result can be delivered again and the
idempotency check prevents duplicate effects.

## Download files before acknowledgement

Output JSON contains file metadata, never file bytes. Download and durably store
or process required bytes before acknowledgement. Verify size and digest where
your workflow depends on file integrity, and treat MIME type and filename as
untrusted display metadata.

## Handle errors by category

Branch on the stable `error.code`, not on the message or HTTP status alone.
Several lifecycle conditions intentionally share a status:

<!-- contract-example:ErrorEnvelope -->

```json
{
  "ok": false,
  "request_id": "req_126",
  "correlation_id": "corr_126",
  "error": {
    "code": "pending_content_conflict",
    "message": "A pending item with this caller_item_id has different content."
  }
}
```

- `400` and `422` mean the request must change. Field errors identify invalid
  paths without echoing sensitive content.
- `401` means the caller credential is absent or unusable. Do not branch on a
  more specific secret lifecycle state.
- `402` can mean `upgrade_required` or `billing_grace_expired`; use the code and
  attached metadata to choose the recovery.
- `404` means the live resource is not available to this caller.
- `409 pending_content_conflict` means use `input/replace` for a real content
  change. `answered_unacknowledged` means read and acknowledge the output first.
  `input_not_pending` means stop the pending-item operation and reconcile state.
- `429` means a rate, quota, storage, or retention limit blocked the operation.
  Honor `Retry-After` when present. Storage and retention limits may have no
  reset time; delete pending work or read and acknowledge completed work as the
  structured limit metadata directs instead of waiting blindly.
- `5xx` means retry only operations that are safe for the caller’s current
  state, using bounded exponential backoff and jitter.

Every JSON response includes `request_id` and `correlation_id`. Preserve them in
content-safe operational logs and support reports. The generated
[error-code reference](public-api-reference.md#error-codes) lists every public
code and its caller recovery.

## Plan for retention

Unacknowledged results are retained for 14 days. Acknowledged results and their
live inputs/files are removed immediately. Persist anything your application
needs long term in its own system of record.

## Production checklist

- Stable `caller_item_id` values survive retries and restarts.
- `output_result_id` guards downstream idempotency.
- Workers follow every pagination cursor.
- Polling uses backoff, jitter, and `Retry-After`.
- File bytes are handled before acknowledgement.
- Credentials never enter prompts or logs.
- Request and correlation ids are retained without review content.
- Integration tests exercise replay between durable handling and ack.
