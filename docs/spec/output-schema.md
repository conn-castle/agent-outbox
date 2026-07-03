# Output Schema

The output queue returns human decisions to the originating caller. Output
results are available only to the account and caller derived from the bearer
key.

## Output Result Shape

`POST /api/output/{output_result_id}/read` returns one
`AgentOutboxOutputResult`. `POST /api/output/read-all` returns pages of the same
shape.

```json
{
  "output_result_id": "out_123",
  "caller_id": "caller_123",
  "caller_item_id": "email:thread_123",
  "action_value": "send",
  "response": {
    "kind": "none"
  },
  "answered_at": "2026-06-30T20:00:00Z",
  "answered_by": "user_123"
}
```

Rules:

- `action_value` is the caller-owned selected `ActionButton.value`.
- `response.kind` matches the selected action popup kind.
- `answered_at` is a UTC ISO-8601 timestamp.
- `answered_by` is a non-secret Agent Outbox user identifier or null.
- File-upload responses include metadata only, never bytes.

## Response Variants

`none`:

```json
{ "kind": "none" }
```

`free_text`:

```json
{ "kind": "free_text", "text": "Final human-entered text" }
```

`single_select`:

```json
{ "kind": "single_select", "value": "approve" }
```

`multi_select`:

```json
{ "kind": "multi_select", "values": ["a", "b"] }
```

`date_picker` date mode:

```json
{
  "kind": "date_picker",
  "mode": "date",
  "value_date": "2026-06-30",
  "display_timezone": "America/New_York"
}
```

Date mode is a civil date and must not be converted to UTC.

`date_picker` datetime mode:

```json
{
  "kind": "date_picker",
  "mode": "datetime",
  "value_utc": "2026-06-30T20:00:00Z",
  "display_timezone": "America/New_York"
}
```

`file_upload`:

```json
{
  "kind": "file_upload",
  "file": {
    "file_id": "file_123",
    "filename": "receipt.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 12345,
    "sha256": "..."
  }
}
```

`file_upload.file` is built from the canonical output-file row. The popup
payload does not keep a second mutable copy of filename, MIME type, size,
digest, or bytes.

## Output Check Page

`GET /api/output/check` returns readiness metadata only:

```json
{
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
```

Check pages must not include `action_value`, `response`, file metadata, or file
bytes. Checking does not mark results as read, disable human undo, delete rows,
or shorten timeout windows.

## Output Read Page

`POST /api/output/read-all` returns full output payloads:

```json
{
  "items": [
    {
      "output_result_id": "out_123",
      "caller_id": "caller_123",
      "caller_item_id": "email:thread_123",
      "action_value": "send",
      "response": {
        "kind": "none"
      },
      "answered_at": "2026-06-30T20:00:00Z",
      "answered_by": "user_123"
    }
  ],
  "has_more": false,
  "next_cursor": null,
  "returned_count": 1,
  "page_limit": 25
}
```

Read-all marks only returned results as read.

## Pagination

Output check and read-all are cursor-paginated.

- Default page size: 25.
- Maximum page size: 100.
- Invalid limits fail loudly with a validation error.
- Results are ordered oldest-first by `answered_at` and `output_result_id`.
- Callers pass the opaque `next_cursor` to fetch the next page.
- Offset and page-number pagination are not supported.
- `has_more`, `next_cursor`, `returned_count`, and `page_limit` are always
  present.
- `output check` also includes `ready_count`.
- If `has_more` is `true`, `next_cursor` is present.
- If `has_more` is `false`, `next_cursor` is `null`.

The cursor is not an authorization boundary. The server applies the account and
caller derived from the bearer key to every request.

The CLI auto-pages `output check` and `output read --all` by default until
`has_more` is false. In JSON mode the CLI reports `complete`, `has_more`,
`next_cursor`, `page_count`, `request_count`, aggregate `returned_count`, and
`page_limit` so agents can detect incomplete bounded reads. Passing
`--no-auto-page`, `--cursor`, or `--page-size` keeps raw API parity for
debugging and bounded reads.

## Delivery And Acknowledgement

- Human answer creation creates exactly one output result for the originating
  caller.
- Output delivery is at least once. The same result can be returned repeatedly
  until acknowledged.
- The first successful read response that includes an `output_result_id` marks
  that result as read and disables human undo.
- Callers must treat `output_result_id` as their idempotency key.
- Callers should acknowledge only after downstream handling is durable.
- Acknowledgement deletes the live output result, attached file rows/bytes, and
  matching input item in one logical operation.
- Duplicate acknowledgement returns a no-op success when retained audit metadata
  proves the authenticated caller already acknowledged the id.
- A never-known id returns not found.
- Unacknowledged outputs are deleted by the hard 14-day output timeout across
  hosted tiers. There is no separate post-read timeout in the MVP.

`input delete` and `output ack` do not consume the monthly caller API request
quota so callers can free storage after quota exhaustion. They may still have
narrow abuse-specific burst or concurrency controls.

## File Download

Output read responses include file metadata only. Raw bytes are returned only
from:

```http
GET /api/output/{output_result_id}/files/{file_id}
```

The endpoint validates account, caller, output result, and file linkage from the
bearer key and path ids. It rejects access after acknowledgement, timeout, or
retention deletion.

Successful downloads return raw bytes with attachment headers and
`X-Content-Type-Options: nosniff`. The server defaults unsafe or missing MIME
types to `application/octet-stream` and emits a durable byte-counted audit event
for each download.
