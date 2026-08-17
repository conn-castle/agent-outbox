# Design a review request

A good review request gives the person enough context to decide, makes the
available choices unambiguous, and returns stable values your code can handle.

## Present the decision clearly

Use `title`, `subtitle`, and `summary` for the information needed at a glance.
Optional details can carry the deeper explanation. `row_type` and visual fields
help a person scan a mixed queue, but they are presentation—not authorization or
workflow state.

Display text may evolve. Protocol values should not. Keep every action and
select-option `value` short, stable, and independent from its label.

## Immediate actions

Use a `none` popup when selecting the action is the complete response. Typical
examples are approve, reject, retry, archive, and escalate.

<!-- contract-example:InputAction -->

```json
{
  "display": "Approve to send",
  "icon": "send",
  "value": "approve_send",
  "overflow": false,
  "tone": "success",
  "style": "solid",
  "popup": { "kind": "none" }
}
```

## Action appearance

Use the optional `tone` and `style` pair to communicate an action's meaning
without sending arbitrary colors or CSS. The fixed tones are `neutral`, `brand`,
`success`, `warning`, and `danger`; the fixed styles are `solid`, `outline`, and
`ghost`. Supply both fields together or omit both to use the default treatment.

Reserve `danger` for actions with harmful or difficult-to-reverse consequences,
not merely for a secondary choice. Prefer one visually dominant solid action per
decision group; outline and ghost treatments keep alternatives available without
making every button compete for attention.

## Free text

Use `free_text` when the person must explain, revise, or supply a bounded text
value. Choose a useful label and constraints; do not make people infer what the
agent expects from a generic comment box.

<!-- contract-example:FreeTextPopup -->

```json
{
  "kind": "free_text",
  "label": "What should change?",
  "placeholder": "Be specific about tone or factual corrections.",
  "default_value": null,
  "multiline": true,
  "min_length": 1,
  "max_length": 2000
}
```

## Single and multiple selection

Use `single_select` for exactly one named value and `multi_select` when several
values may apply. Option values are returned unchanged and must be unique within
the popup.

For multiple selection, `min_selected` and `max_selected` make the expected
answer explicit. A zero minimum is appropriate only when an empty selection is
meaningful.

<!-- contract-example:SingleSelectPopup -->

```json
{
  "kind": "single_select",
  "label": "Which environment should receive this release?",
  "options": [
    { "display": "Staging", "value": "staging", "icon": "flask-conical" },
    { "display": "Production", "value": "production", "icon": "rocket" }
  ]
}
```

<!-- contract-example:MultiSelectPopup -->

```json
{
  "kind": "multi_select",
  "label": "Which checks should run again?",
  "options": [
    { "display": "Unit tests", "value": "unit" },
    { "display": "Browser tests", "value": "browser" }
  ],
  "min_selected": 1,
  "max_selected": 2
}
```

## Dates and times

Date pickers have two distinct modes:

- `date` returns a civil `YYYY-MM-DD` value. Do not convert it to UTC.
- `datetime` returns a UTC instant and the timezone shown during review.

Use date mode for concepts such as a due date or billing day. Use datetime mode
for a meeting, publish time, or other instant on a timeline.

<!-- contract-example:DatePickerPopup -->

```json
{
  "kind": "date_picker",
  "label": "When should this publish?",
  "mode": "datetime",
  "placeholder": "Choose a time",
  "display_timezone": "America/New_York",
  "min_value": "2026-08-15T12:00:00Z",
  "max_value": "2026-08-22T12:00:00Z"
}
```

## File responses

Use `file_upload` when the human must provide one file. You can restrict the
accepted MIME types. Availability depends on the account tier.

<!-- contract-example:FileUploadPopup -->

```json
{
  "kind": "file_upload",
  "label": "Upload the signed approval",
  "accept_mime_types": ["application/pdf"]
}
```

The read response contains `file_id`, filename, MIME type, size, and SHA-256
metadata—not a URL. Construct the authenticated download route from the output
and file ids:

```bash
curl "https://app.agent-outbox.dev/api/output/<output_result_id>/files/<file_id>" \
  --header "Authorization: Bearer <caller_api_key>" \
  --output response-file
```

Download bytes before acknowledgement. Acknowledgement removes attached file
data together with the live result.

## Handle typed responses

The selected action’s popup kind determines `response.kind`. Branch on that
stable discriminator and then read only the fields for that response.

<!-- contract-example:ActionResponse -->

```json
{ "kind": "free_text", "text": "Use a warmer opening paragraph." }
```

<!-- contract-example:ActionResponse -->

```json
{ "kind": "single_select", "value": "production" }
```

<!-- contract-example:ActionResponse -->

```json
{ "kind": "multi_select", "values": ["unit", "browser"] }
```

<!-- contract-example:ActionResponse -->

```json
{
  "kind": "date_picker",
  "mode": "date",
  "value_date": "2026-08-22",
  "display_timezone": "America/New_York"
}
```

<!-- contract-example:ActionResponse -->

```json
{
  "kind": "date_picker",
  "mode": "datetime",
  "value_utc": "2026-08-22T16:00:00Z",
  "display_timezone": "America/New_York"
}
```

<!-- contract-example:ActionResponse -->

```json
{
  "kind": "file_upload",
  "file": {
    "file_id": "file_123",
    "filename": "approval.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 12345,
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

## Content and structural limits

Display fields accept a safe, sanitized HTML subset; active content, embedded
resources, unsafe attributes, and unsafe URLs are rejected. Icon fields accept
only the generated Lucide icon enum in the OpenAPI contract—never arbitrary SVG
or HTML. Color fields accept the named product colors `red`, `orange`, `yellow`,
`green`, `blue`, `purple`, `pink`, and `teal`; arbitrary CSS colors are
rejected.

JSON request bodies handled by the shared caller parser are limited to 128,000
bytes. Structural schema validation is followed by semantic checks for unique
protocol values, supported icons, safe content, numeric bounds, date ranges,
MIME patterns, and account entitlements.

## Visual context and links

Context links can take the reviewer to a trusted source of truth. Numeric bars,
progress rings, and pills can summarize state without forcing the person to
parse it from prose.

Treat visuals as explanatory only. Your service must still enforce every
permission and business rule when it handles the returned action.

## Replace or delete pending work

Use `input/replace` when the complete pending request has changed. Replacing is
not a partial patch. Use `input/delete` when the work no longer needs a human
decision.

Once the item is answered, preserve the delivery lifecycle: read and acknowledge
the output instead of trying to rewrite the original request.
