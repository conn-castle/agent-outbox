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
  "answered_by": "user_123",
  "raw_input": {
    "caller_item_id": "email:thread_123",
    "priority": "high",
    "row_type": { "display": "Email draft", "icon": "mail" },
    "row_accent_color": null,
    "title": "Reply to Acme Corp",
    "subtitle": "A customer response is ready for review.",
    "corner": null,
    "summary": "Approve the prepared response before it is sent.",
    "details": null,
    "link_buttons": [],
    "card_visual": null,
    "skip_disabled": false,
    "actions": [
      {
        "display": "Approve to send",
        "icon": "send",
        "value": "approve_send",
        "overflow": false,
        "tone": "success",
        "style": "solid",
        "popup": { "kind": "none" }
      }
    ]
  }
}
```

Rules:

- `action_value` is the caller-owned selected `ActionButton.value`.
- `response.kind` matches the selected action popup kind.
- `answered_at` is a UTC ISO-8601 timestamp.
- `answered_by` is a non-secret Agent Outbox user identifier or null.
- File-upload responses include metadata only, never bytes.
- `raw_input` is required on full output results. It is the canonical accepted
  input for the matching live item, as defined in
  [input-schema.md](input-schema.md#canonical-accepted-input). Output/check
  remains metadata-only and does not include `raw_input`.
- If that retained input cannot be reconstructed, the read fails with
  `temporary_unavailable` before any result is marked read. This is not
  `unavailable_outputs` file-metadata degradation.

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

`file_upload.file` is built from the canonical output-file row. Exactly one
output-file row may exist for a `file_upload` output result. The popup payload
does not keep a second mutable copy of filename, MIME type, size, digest, or
bytes.

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
      "answered_by": "user_123",
      "raw_input": {
        "caller_item_id": "email:thread_123",
        "priority": "high",
        "row_type": { "display": "Email draft", "icon": "mail" },
        "row_accent_color": null,
        "title": "Reply to Acme Corp",
        "subtitle": "A customer response is ready for review.",
        "corner": null,
        "summary": "Approve the prepared response before it is sent.",
        "details": null,
        "link_buttons": [],
        "card_visual": null,
        "skip_disabled": false,
        "actions": [
          {
            "display": "Approve to send",
            "icon": "send",
            "value": "approve_send",
            "overflow": false,
            "tone": "success",
            "style": "solid",
            "popup": { "kind": "none" }
          }
        ]
      }
    }
  ],
  "unavailable_outputs": [],
  "unavailable_count": 0,
  "has_more": false,
  "next_cursor": null,
  "returned_count": 1,
  "page_limit": 25
}
```

Read-all marks only returned results as read. If one scanned `file_upload` row
cannot materialize safe file metadata, read-all still returns HTTP 200 with the
successfully materialized `items`, advances the cursor over the scanned row, and
adds a filename-free entry to top-level `unavailable_outputs`. File-degraded
rows are not reconstructed as `raw_input`; a malformed input on a file-degraded
row does not fail the page.

```json
{
  "output_result_id": "out_456",
  "code": "temporary_unavailable",
  "message": "Output file metadata is temporarily unavailable."
}
```

`unavailable_count` equals `unavailable_outputs.length`. `returned_count`
continues to count only `items.length`; unavailable rows remain unread and may
be retried by explicit output id or a later read-all call.

## Pagination

Output check and read-all are cursor-paginated.

- Default page size: 25.
- Maximum page size: 100.
- Invalid limits fail loudly with a validation error.
- Results are ordered oldest-first by `answered_at` and `output_result_id`.
- Each result also carries its full canonical input. Use a smaller page `limit`
  when inputs are large to keep response sizes bounded for your worker.
- Callers pass the opaque `next_cursor` to fetch the next page.
- Offset and page-number pagination are not supported.
- `has_more`, `next_cursor`, `returned_count`, and `page_limit` are always
  present.
- `output check` also includes `ready_count`.
- `output read-all` also includes `unavailable_outputs` and `unavailable_count`.
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
- The first successful single-output read response, or read-all `items` entry,
  marks that result as read and disables human undo. Read-all
  `unavailable_outputs` entries do not mark those results read.
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
