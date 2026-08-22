# Build a UI integration

The OpenAPI document is the machine-readable contract for a UI integration, but
it is only one input. Use it for routes, request and response types, and
generated clients. Use the authored guides for lifecycle and interaction
semantics that a schema cannot express.

## Give a UI coding agent these sources

A UI-focused coding agent should receive this guide and the
[OpenAPI 3.1 document](openapi.json). It should also consult:

- [Review patterns](public-api-capabilities.md) to choose actions, popups, and
  typed responses.
- [How Agent Outbox works](public-api-concepts.md) to model asynchronous state
  and the check, read, and acknowledgement boundaries.
- [Reliability](public-api-reliability.md) to design retries, errors, files, and
  recovery states.

Do not ask the agent to infer product behavior from OpenAPI schemas alone. Do
not give it internal control-plane, billing, or operator specifications unless
it is working on those systems explicitly.

## Keep the credential behind your UI

A caller credential is a service secret. Never ship it in browser JavaScript, a
mobile application bundle, client-visible environment variables, HTML, or
telemetry.

For a web product, call Agent Outbox from your trusted backend, server action,
or backend-for-frontend. Your browser UI should call your own application
boundary, and that trusted boundary should attach the caller bearer credential
when it calls Agent Outbox.

```text
Browser UI → your trusted backend → Agent Outbox caller API
                                     ↓
Human review UI ← Agent Outbox queue  decision
                                     ↓
Browser UI ← your trusted backend ← read and handle output
```

Generate an API client or types from the OpenAPI document on the trusted side of
that boundary. Keep generated files reproducible instead of editing them by
hand.

## Model the asynchronous lifecycle

Agent Outbox is not a synchronous modal API. Your interface should let the
initiating workflow finish or move on while the human review remains pending.

| Application state | What happened                                                           | Appropriate UI treatment                                                      |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pending           | `input/send` accepted the review request.                               | Show that review was requested; do not keep a request or spinner open.        |
| Ready             | `output/check` returned an `output_result_id`.                          | Schedule trusted backend work to read it; no answer content is available yet. |
| Read              | `output/read` or `output/read-all` returned the decision.               | Reconcile by `output_result_id`; the person's undo is now disabled.           |
| Handled           | Your application durably recorded the decision or completed its effect. | Reflect the resulting product state before acknowledging.                     |
| Acknowledged      | `output/ack` succeeded.                                                 | Treat the live Agent Outbox item as removed; retain your own durable history. |

`ready_count` includes all live results awaiting acknowledgement, including
results already read. Do not label it as an unread count.

## Use separate UI surface models

Do not flatten the Agent Outbox review row and your application's status or
history row into one universal component. They have different owners, data
availability, and behavior. Treat action popups as a third, follow-on surface
owned by each individual action.

### Agent Outbox review row

The human decision row has seven caller-content slots. Product controls,
responsive infrastructure, and row modifiers are separate categories so API
fields are not confused with product-owned layout.

The anatomy below is rendered by the same row-frame component and responsive CSS
as the human review queue. Its labels replace caller content, but its slot
placement, wrapping, truncation, breakpoints, and action layout are the live
product implementation—not a diagrammatic approximation.

Use **Show example** beside each preview to replace the explanatory overlays
with realistic caller content without changing the component or responsive
layout. **Open preview** preserves the selected Anatomy or Example mode.

When a preview is wider than the documentation column, use its horizontal
scrollbar, a horizontal trackpad gesture, or open that exact-width preview in a
separate page. Ordinary vertical scrolling always continues down the page.

<!-- review-row-anatomy -->

The background legend distinguishes caller-controlled content from Agent Outbox
controls. The border legend describes content-driven sizing within the current
responsive layout:

- **Fixed width + height:** content does not change either dimension.
- **Width can grow:** a single-line slot can widen with content until its
  available space is exhausted.
- **Height can grow:** the slot keeps its column width while additional or
  variant content can increase its height.
- **Width + height can grow:** content can consume available width and add lines
  vertically.

Responsive reflow is separate from content-driven sizing. Above 800 CSS pixels,
the action rail is a fixed-width right column and the visual/Details column is
fixed within the fluid content area. At 800 pixels and below, actions move below
the content. At 520 pixels and below, the visual and Details slots share one row
beneath the title. The row height is always content-driven. Metadata can wrap,
titles can wrap, visual labels ellipsize, summaries clamp to two lines, and the
number of actions can increase row height. Subtitles are single-line on larger
layouts and clamp to two wrapped lines at 520 pixels and below. The stable
scrollbar gutter is browser-owned width reserved outside the row content.

| Slot                | Contents                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classification chip | `row_type.display` and `row_type.icon`.                                                                                                                          |
| Corner metadata     | Optional `corner` context such as an amount, environment, or count. When absent, Agent Outbox shows a visually distinct product-owned update timestamp fallback. |
| Title block         | Required `title` and `subtitle`. The queue title opens details, so nested links in those fields are flattened to text in the row.                                |
| Summary             | Required `summary` describing the decision being requested.                                                                                                      |
| Visual              | No visual, or one `numeric_bar`, `progress_ring`, or `pill` card visual.                                                                                         |
| Context links       | Zero to 32 `link_buttons`, each with `display`, `icon`, and HTTP(S) `url`.                                                                                       |
| Action bar          | Primary `actions` with `overflow: false`, each with `display`, `icon`, stable `value`, optional fixed `tone` and `style`, and its own `popup`.                   |

Product controls are not caller-content slots:

- **Details** is always available and opens the complete decision surface;
  optional caller `details` supplies a rich-content section inside that surface,
  labeled **Details**.
- **Skip** is product-owned; `skip_disabled` controls whether it is available.
- **More actions** is product-owned and appears on pending rows when one or more
  actions use `overflow: true`. Answered rows keep the result and undo flow
  instead of live overflow decision controls.

The stable scrollbar gutter is responsive infrastructure, not caller content.

Visual variants contain these fields:

- `numeric_bar`: `label`, numeric `value`, formatted `display`, optional `unit`,
  `min_value`, and `max_value`;
- `progress_ring`: the numeric-bar fields plus optional `color`;
- `pill`: `text`, optional `icon`, and `color`.

Keep these inputs as modifiers rather than allocating more content slots:

- `priority` controls ordering and a restrained visible Low, Normal, High, or
  Urgent priority treatment; it never implies an unsupplied deadline;
- `row_accent_color` decorates the row container;
- paired `actions[].tone` and `actions[].style` select a semantic button
  treatment from fixed API values rather than arbitrary colors or CSS;
- `actions[].overflow` places each action in the primary bar or the compact More
  menu beside Skip;
- `skip_disabled` controls the system skip affordance in the row metadata area.

The review row has ordinary interaction states such as rest, focus, and
selection. Its lifecycle states are pending and answered-but-undoable. After a
person answers, Agent Outbox can offer undo until the first successful caller
read permanently disables it.

Safe HTML applies across `corner`, `title`, `subtitle`, `summary`, and
`details`; it is not a separate slot. The supported elements are paragraphs,
line breaks, headings `h3` through `h6`, emphasis, inline and preformatted code,
ordered and unordered lists, blockquotes, tables, spans, and links. Icons and
colors remain constrained by the OpenAPI allowlists and safe-color rules.

### Per-action popup

Each `actions[]` entry owns its own popup. A row does not have one shared
interaction slot. Selecting an action opens a follow-on popup surface keyed by
`actions[].popup.kind`:

| Variant         | Contents                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `none`          | No popup fields; choosing the action completes it immediately.                                                  |
| `free_text`     | `label`, optional `placeholder` and `default_value`, `multiline`, and optional length bounds.                   |
| `single_select` | `label` and one to 64 options containing `display`, stable `value`, and optional `icon`.                        |
| `multi_select`  | The select-option fields plus optional `min_selected` and `max_selected`.                                       |
| `date_picker`   | `label`, `mode`, optional `placeholder`, optional `display_timezone`, and optional `min_value` and `max_value`. |
| `file_upload`   | `label` and optional `accept_mime_types`; omitting the MIME list declares no request-level type restriction.    |

Date-picker mode is part of the interaction shape. `date` represents a civil
date, while `datetime` represents a UTC instant with optional review-timezone
context. Agent Outbox renders `placeholder`, when supplied, as accessible helper
text for both modes because native date-input placeholder behavior is not
consistent. Both modes enforce inclusive `min_value` and `max_value`; datetime
bounds are converted from UTC into the displayed timezone for the local picker.

### Caller status and history row

The consuming product owns this surface and applies its own design system. It
has seven logical slots:

| Slot                 | Contents                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Identity and context | `output_result_id`, `caller_id`, `caller_item_id`, and caller-cached immutable request context.                                   |
| Status               | Pending, ready, read, caller-owned handled, or acknowledged state.                                                                |
| Decision             | `action_value`, rendered through the caller's label map.                                                                          |
| Typed response       | `response`, branched on `kind` and date-picker `mode`.                                                                            |
| Attribution          | UTC `answered_at` and nullable `answered_by`.                                                                                     |
| File handling        | `output_result_id`, file metadata, authenticated download state, and acknowledgement gating until downloaded bytes are durable.   |
| Recovery             | `unavailable_outputs[].output_result_id`, `code`, and `message`, rendered as a bounded-retry error rather than a lifecycle badge. |

Use `output_result_id` for reconciliation and duplicate-delivery safety. Do not
key history solely by `caller_item_id`; that identifier is only unique while the
caller's item is live. `caller_id` may remain hidden in a single-caller UI, but
it still belongs to identity.

Typed response variants contain:

- `none`: no additional value;
- `free_text`: `text`, which may be empty when the original popup allowed it;
- `single_select`: one stable `value`;
- `multi_select`: stable `values`, possibly an intentional empty array;
- date mode: `value_date` and nullable `display_timezone`;
- datetime mode: `value_utc` and nullable `display_timezone`;
- `file_upload`: `file_id`, `filename`, `mime_type`, `size_bytes`, and `sha256`.

Pending operation feedback may also expose revision and idempotency metadata.
Acknowledgement reports whether the result was newly or already acknowledged.
Once acknowledged, Agent Outbox removes the live pair; durable history belongs
to the consuming application.

### Keep collection and system UI outside the row model

Loading, empty state, pagination, `ready_count`, returned and unavailable
counts, account limits, caller credential status, global errors, validation
fields, upgrade prompts, rate-limit timing, and request or correlation ids are
page-, collection-, account-, or system-level concerns. Do not allocate row
slots for them.

## Render typed decisions deliberately

The request defines the human interaction; the output reports the selected
action and its typed response. Keep action and option `value` fields stable even
when labels change.

Branch on `response.kind`. Date-picker responses require the additional `mode`
field: `date` returns a civil date, while `datetime` returns a UTC instant and
the displayed timezone. File responses return metadata; download bytes from the
authenticated file route before acknowledgement.

The API schema describes data, not visual styling. Use your own product design
system for caller-side status and history surfaces. The human decision surface
itself is rendered by Agent Outbox from the submitted title, context, visuals,
actions, and popup definitions.

## Design loading and error states by code

Use stable `error.code` values for behavior and human-readable messages for
display only. In particular:

- Ask the user or caller to correct validation failures before retrying.
- Resolve content conflicts by replacing genuinely changed pending work.
- Use bounded backoff for transient failures and honor `Retry-After` when it is
  present.
- Resolve storage and retention limits by deleting pending work or acknowledging
  handled output; waiting alone may not help.
- Preserve `request_id` and `correlation_id` in content-safe support context.

## UI integration checklist

- The OpenAPI document drives network types and generated clients.
- Caller credentials exist only in a trusted process or secure native store.
- Pending review never leaves a browser request or loading indicator open.
- Stable ids, not labels, drive reconciliation and downstream behavior.
- Every response kind and both date-picker modes have an explicit UI path.
- Duplicate output delivery is harmless because handling is keyed by
  `output_result_id`.
- Files are downloaded before acknowledgement.
- Error states branch on `error.code` and offer an actionable recovery.
- Accessibility, responsive layout, and visual styling come from the consuming
  product's design system rather than assumptions encoded in the API schema.
