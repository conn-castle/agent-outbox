# Input Schema

Input submissions define the human review surface. They are caller-authored
product data, not authorization data. The server derives `account_id` and
`caller_id` from the bearer key and stores those ids on accepted rows.

## Submission Shape

`POST /api/input/send` and `POST /api/input/replace` accept the same
`AgentOutboxInputSubmission` JSON body. `POST /api/input/read` and full output
reads return that accepted shape as `raw_input`.

```json
{
  "caller_item_id": "email:thread_123",
  "priority": "normal",
  "row_type": {
    "display": "Email Draft",
    "icon": "mail"
  },
  "row_accent_color": "blue",
  "title": "<strong>Reply to Acme Corp</strong>",
  "subtitle": "Draft response prepared by Steward",
  "corner": "2 min ago",
  "summary": "Approve or edit the proposed response before it is sent.",
  "details": "<p>The customer asked for updated timing.</p>",
  "link_buttons": [],
  "card_visual": null,
  "skip_disabled": false,
  "actions": [
    {
      "display": "Send",
      "icon": "send",
      "value": "send",
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

Required top-level fields:

- `caller_item_id`
- `row_type`
- `title`
- `subtitle`
- `summary`
- `link_buttons`
- `actions`

Optional top-level fields:

- `priority`, default `normal` when omitted or JSON `null`
- `row_accent_color`
- `corner`
- `details`
- `card_visual`
- `skip_disabled`, default `false` when omitted or JSON `null`

The request must not include `caller_id`.

## Field Rules

- `caller_item_id` is the caller-owned stable logical item id. The live
  uniqueness boundary is `(caller_id, caller_item_id)` while the item is pending
  or answered but unacknowledged.
- `priority` is one of `low`, `normal`, `high`, or `urgent`.
- `row_type.display` and `row_type.icon` are display metadata. Row type has no
  stable product key in the MVP.
- `icon` fields are supported Lucide icon names from the server allow-list.
  Callers cannot submit arbitrary SVG, HTML, or unsupported icon keys.
- `title`, `subtitle`, `corner`, `summary`, and `details` are sanitized HTML
  strings.
- `link_buttons` are context links, not actions. Each link has `display`,
  `icon`, and `url`.
- `card_visual.kind` is one of `numeric_bar`, `pill`, or `progress_ring`.
- `actions` define the choices a human can make. `ActionButton.value` is the
  caller-owned action enum returned in the output result.
- `tone` and `style` optionally select a fixed semantic appearance. Supply both
  or omit both. Tones are `neutral`, `brand`, `success`, `warning`, and
  `danger`; styles are `solid`, `outline`, and `ghost`. Arbitrary colors and CSS
  are not accepted.
- `overflow` controls presentation only. It is not a permission boundary.
- `skip_disabled` controls a front-end-only skip affordance. It does not change
  backend lifecycle, permissions, or output semantics.

## Protocol-Shaped Values

`ActionButton.value` and `PopupOption.value` must be:

- 1 to 128 ASCII characters;
- matched by `[A-Za-z0-9._:-]+`;
- unique within the relevant action set or popup option list;
- stable for caller downstream handling;
- separate from display text.

Agent Outbox stores and returns these values without interpreting their domain
meaning.

## Popup Kinds

`action.popup.kind` is one of:

- `none`
- `free_text`
- `single_select`
- `multi_select`
- `date_picker`
- `file_upload`

`free_text` fields:

- `label`
- `placeholder`
- `default_value`
- `multiline`
- `min_length`
- `max_length`

`min_length` must be non-negative, `max_length` must be positive when present,
and `min_length <= max_length`.

`single_select` and `multi_select` fields:

- `label`
- `options`
- `min_selected` and `max_selected` for `multi_select`

Options must contain 1 to 64 entries. `multi_select` bounds must satisfy
`0 <= min_selected <= max_selected <= len(options)`, with omitted `min_selected`
behaving as `0` and omitted `max_selected` behaving as the option count.

`date_picker` fields:

- `label`
- `mode`, either `date` or `datetime`
- `placeholder`
- `display_timezone`
- `min_value`
- `max_value`

When set, `display_timezone` is an IANA timezone name. Date mode uses civil
`YYYY-MM-DD` values and must not be silently converted to UTC. Datetime mode
uses UTC instants for output and includes the displayed timezone for audit. When
`min_value` or `max_value` is provided, the value must match the picker mode:
date-only values for `date`, UTC datetime values for `datetime`. The range is
inclusive, `min_value <= max_value`, and submitted answers must fall inside the
configured range.

`file_upload` fields:

- `label`
- `accept_mime_types`

`accept_mime_types` is either omitted/null or a non-empty list of valid MIME
type patterns. Hosted-free callers cannot submit `file_upload` actions; the
server returns `upgrade_required` with
`limit_reason_code: file_upload_upgrade_required`. Paid hosted and self-hosted
callers can submit `file_upload` actions; the human answer path validates
exactly one uploaded file against the popup MIME allow-list and canonical file
upload limits before storing bytes.

## Card Visuals

`numeric_bar` fields:

- `label`
- `value`
- `display`
- `unit`
- `min_value`
- `max_value`

`progress_ring` has the same bounded numeric fields and may include `color`.

For both numeric visual kinds, values must be finite numbers, `min_value` must
be less than `max_value`, and `value` must be within the inclusive range. NaN,
infinite, unbounded, or inverted values fail validation instead of being
clamped.

`pill` fields:

- `text`
- `icon`
- `color`

`color` is a named product-palette color.

## HTML Safety

Allowed elements are:

```text
p br strong em b i u code pre ul ol li blockquote h3 h4 h5 h6 table thead tbody tr th td span a
```

Allowed attributes are:

- `href` and `title` on `a`
- `colspan` and `rowspan` on table cells

Links must use `http`, `https`, or `mailto`. Disallowed content includes
scripts, styles, iframes, forms, inputs, buttons, images, media, SVG, MathML,
event handlers, inline `style`, arbitrary `class`/`id`, `javascript:` URLs, and
data URLs.

## Colors

`row_accent_color` and visual `color` fields accept only these named colors:

`red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, and `teal`.

The product maps each name to its coordinated brand-palette value. Raw CSS
colors, including hex, RGB, and HSL values, are rejected. This keeps review UI
on-brand and lets the palette evolve without changing caller data.

## Limits

- Input submission request body: 128,000 bytes before file upload payloads.
- Human uploaded raw file bytes: 32,000,000 bytes per file on paid/self-hosted
  profiles.
- `link_buttons`: maximum 32.
- `actions`: 1 to 32.
- Select popup options: 1 to 64.

Do not add per-field string caps for caller display strings beyond the overall
request-size cap, HTML safety rules, and protocol-shaped identifier rules.
Infrastructure safety caps are allowed only when documented and fail loudly.

## Normalization And Fingerprints

The server validates, sanitizes, and normalizes accepted input before storage.
Duplicate-submit equality is based on that accepted normalized shape.

Callers do not send content fingerprints. If the server cannot safely determine
whether a repeated `caller_item_id` is equivalent, it must fail with conflict
rather than treating the request as a duplicate success.

## Input Semantics

`input send` is retry-safe create:

- creates a pending item when no live item exists for the same authenticated
  caller and `caller_item_id`;
- returns duplicate success for an equivalent pending item;
- fails with `pending_content_conflict` for different pending content;
- fails with `answered_unacknowledged` for an answered item whose output is not
  acknowledged;
- never mutates an existing live item.

`input replace` is explicit pending update:

- allowed only while the item is pending;
- replaces the item and child rows wholesale;
- increments the server-owned revision only when content changes;
- may return no-op success for same-content replacement;
- does not create a missing item.

`input delete` removes only pending items:

- deletes the pending item and child rows;
- frees live queued-input/storage counts;
- emits content-safe audit/accounting events;
- fails for answered items and does not delete matching output results;
- does not consume the monthly caller API request quota.

Answered items remain visible until acknowledgement, output-timeout cleanup, or
pre-read human undo resolves the pair.

## Canonical Accepted Input

`raw_input` is the complete canonical accepted `InputSubmission`: validated,
sanitized, default-expanded, and limited to fields Agent Outbox accepted and
uses. It is not the original request JSON and does not preserve unknown
properties.

The public form:

- includes normalized nullable and defaulted fields as explicit `null` or values
  where the parser does, including default `priority` (`normal`) and
  `skip_disabled` (`false`);
- omits action `tone` and `style` when the caller did not supply them;
- flattens card visuals with `kind`;
- preserves child order for link buttons, actions, and popup options;
- strips internal display-order fields that exist only for fingerprint
  stability.

The stored fingerprint is computed from that same accepted content, including
internal option order fields. Public `raw_input` is the fingerprint form with
those internal fields removed. If reconstruction cannot match the stored
fingerprint or the public canonical form, input and output reads fail with
`temporary_unavailable` rather than returning a guessed body.

The request `InputSubmission` schema remains weaker than the returned canonical
form: callers may omit defaulted and nullable fields on send and replace. Reads
always return those fields explicitly (`priority`, `skip_disabled`,
`row_accent_color`, `corner`, `details`, and `card_visual`).

Values accepted into a live retained input must remain supported and readable
for that item's retention window. Narrowing a public enum, pattern, or other
accept-list requires compatible handling of already-stored live values; do not
make reconstruction of retained rows fail by dropping a previously accepted
value.

## Live Input Reads

`GET /api/input/list` enumerates live retained input metadata for the
authenticated caller. `POST /api/input/read` returns one live item's metadata
plus `raw_input`.

- Visible inputs are pending items and answered items whose output is still
  unacknowledged.
- Caller-deleted, acknowledged, expired, and retention-cleaned inputs are
  absent.
- List pages use a stable indexed internal order and the same default page size
  (25) and maximum (100) as output pages.
- Public results use `caller_item_id` and opaque cursors. Internal
  `input_item_id` is not exposed.
- Both routes are non-mutating and return `Cache-Control: no-store`.
- Both routes share the `output_check_read` per-minute limit and consume monthly
  API request quota.
