# Agent Outbox

> Status: Agent Outbox is under active development and has not been publicly
> released yet.

Agent Outbox is a hosted, source-available review queue for agent-prepared work.

Agents and services submit typed review items, a human makes the smallest useful
decision, and the originating caller reads the typed result asynchronously. It
is built for approvals, edits, answers, date choices, file requests, and other
human-in-the-loop checkpoints where an agent should not act alone.

Agent Outbox is not a replacement for Gmail, X/Twitter, LinkedIn, finance apps,
messaging systems, or any other source system. Callers own source-system reads,
writes, retries, reconciliation, and downstream execution. Agent Outbox owns the
review lifecycle, the human decision surface, and typed output delivery.

For repository navigation, see [TOC.md](TOC.md).

## Hosted Service

Agent Outbox is not publicly released yet. The planned public hosted service
will use:

- `https://agent-outbox.dev` for product documentation
- `https://app.agent-outbox.dev` for the human app and caller API

The current repository implements:

- Clerk-backed sign-in, sign-out, and a protected human placeholder route
- Account-scoped callers and display-once API credentials
- Caller-authenticated raw HTTP status, input, output, acknowledgement, and
  output-file download routes
- Free-tier queue caps, caller limits, retention primitives, cleanup primitives,
  and runtime canaries
- Sentry, Cloudflare, and Supabase/Postgres-backed observability foundations

The installable CLI, full human review queue UI, human-approved caller
registration/rotation/revocation, Stripe billing, and paid file-upload workflow
are later roadmap items.

The hosted service has one app/API origin. Caller API routes live under
`https://app.agent-outbox.dev/api/...`.

## Target Product Flow

1. A caller connects to an Agent Outbox account.
2. The caller submits a typed input item describing what the human should
   review.
3. Agent Outbox renders the item in the web review UI with caller-defined
   actions.
4. The human approves, rejects, edits, uploads a file, chooses a date, selects
   an option, or submits another typed response.
5. Agent Outbox writes one output result for the originating caller.
6. The caller checks, reads, handles, and acknowledges the output result.

The API is fully asynchronous. Callers do not block while a human reviews an
item.

## Example Use Cases

- Review automated agent email triage before messages are archived, labeled, or
  escalated.
- Review proposed replies to LinkedIn messages before the caller sends them.
- Approve destructive actions from always-running agents when the decision does
  not need to happen in real time.
- Review drafted social posts or replies before publishing or scheduling.
- Ask a human to classify ambiguous finance, support, or operations items before
  the caller updates its source system.

## Quickstart

Set up the current repository:

```bash
make setup
make check
```

Start the local Next.js app/API origin:

```bash
make dev
```

Provider-backed runtime canaries are available when `.env` contains real local
development Clerk, Postgres/Supabase, Sentry, caller-key hash, and smoke-token
values:

```bash
make smoke-runtime
```

There is not yet an installable `agent-outbox` CLI or Homebrew package. Current
caller integrations should use the raw HTTP contract in [docs/spec](docs/spec)
with a provisioned caller API key.

## Input Items

Input items define the review surface. Each item includes:

- A caller-owned `caller_item_id`
- A queue priority: `low`, `normal`, `high`, or `urgent`
- Row display metadata, including type, icon, accent color, title, subtitle,
  summary, and optional details
- Context links
- Optional card visuals such as numeric bars, pills, and progress rings
- One or more action buttons
- Optional typed popups for free text, single select, multi select, date or
  datetime input
- Planned file-upload actions, which currently fail loud until the paid upload
  workflow is implemented

Example:

```json
{
  "caller_item_id": "email:thread_123",
  "priority": "high",
  "row_type": {
    "display": "Email Draft",
    "icon": "mail"
  },
  "row_accent_color": "#2563eb",
  "title": "<strong>Reply to Acme Corp</strong>",
  "subtitle": "Draft response prepared by Steward",
  "corner": "2 min ago",
  "summary": "Approve or edit the proposed response before it is sent.",
  "details": "<p>The customer asked for updated implementation timing.</p>",
  "link_buttons": [
    {
      "display": "Open source thread",
      "icon": "external-link",
      "url": "https://mail.google.com/"
    }
  ],
  "card_visual": {
    "kind": "pill",
    "text": "Needs review",
    "icon": "alert-circle",
    "color": "#f59e0b"
  },
  "skip_disabled": false,
  "actions": [
    {
      "display": "Send",
      "icon": "send",
      "value": "send",
      "overflow": false,
      "popup": {
        "kind": "none"
      }
    },
    {
      "display": "Edit then send",
      "icon": "pencil",
      "value": "edit_send",
      "overflow": false,
      "popup": {
        "kind": "free_text",
        "label": "Final email",
        "placeholder": "Edit the response",
        "default_value": "Thanks for the update. Here is the revised timeline...",
        "multiline": true,
        "min_length": 1,
        "max_length": 8000
      }
    },
    {
      "display": "Do not send",
      "icon": "x",
      "value": "reject",
      "overflow": true,
      "popup": {
        "kind": "none"
      }
    }
  ]
}
```

Agent Outbox validates and sanitizes submitted content. HTML fields support a
safe document-content subset; scripts, styles, embeds, arbitrary SVG, data URLs,
and executable attributes are rejected.

## Output Results

Output results are available only to the caller that submitted the matching
input item. A result includes:

- The Agent Outbox `output_result_id`
- The original `caller_item_id`
- The selected caller-defined action value
- The typed popup response, when the action required one
- File metadata for attached output files, when a file result exists
- Delivery and read/acknowledgement metadata

File bytes are fetched through a dedicated authorized download route:

```http
GET /api/output/{output_result_id}/files/{file_id}
```

Callers acknowledge results only after their own downstream handling is durable.
Acknowledgement removes the live queue pair from Agent Outbox.

## Queue Semantics

Agent Outbox uses two queues:

- **Input queue:** caller to Agent Outbox. Pending work visible to humans.
- **Output queue:** Agent Outbox to caller. Completed human decisions waiting
  for caller handling.

Important behavior:

- `POST /api/input/send` is retry-safe create.
- `POST /api/input/replace` explicitly updates a pending item.
- `POST /api/input/delete` removes only pending items.
- Answered items stay visible until the caller acknowledges the matching output
  result or retention cleanup resolves it.
- Human undo is available before the caller reads the output result.
- `GET /api/output/check` is non-mutating readiness metadata.
- Output read routes return full output payloads and mark returned results as
  read.
- `POST /api/output/{output_result_id}/ack` is idempotent after caller-side
  durable handling.

Delivery is asynchronous and at least once. Callers deduplicate by
`output_result_id`.

## Caller Integration

Raw HTTP is the canonical integration contract. The future `agent-outbox` CLI
must map directly to the HTTP API; it does not exist in the current repository.

Implemented caller-authenticated HTTP areas:

- `GET /api/caller/status` for caller health and account limit metadata
- `GET /api/account/status` for account status using existing caller credentials
- `POST /api/input/send`, `POST /api/input/replace`, and
  `POST /api/input/delete`
- `GET /api/output/check`, `POST /api/output/{output_result_id}/read`,
  `POST /api/output/read-all`,
  `GET /api/output/{output_result_id}/files/{file_id}`, and
  `POST /api/output/{output_result_id}/ack`

Human-approved caller registration, caller rotation/revocation, upgrade/billing
flows, CLI diagnostics, and CLI documentation commands are planned but not
implemented.

## Product Boundaries

Agent Outbox deliberately stays generic:

- It stores temporary review state, not source-system truth.
- It returns caller-defined action values, not domain-specific decisions.
- It renders supported typed controls, not arbitrary caller UI.
- It sanitizes caller-provided HTML and color values before rendering.
- It enforces account, caller, tier, quota, retention, and file limits.
- It leaves external writes to the caller after acknowledgement-safe handling.

This makes the same review primitive work for email, social posts, finance
triage, messaging workflows, local automations, and future agent systems.

## Architecture

The target hosted product runs as one Next.js application on Cloudflare Workers
through OpenNext. Supabase Postgres stores accounts, callers, live queues,
output results, file bytes when file workflows exist, quotas, active limit
blocks, and audit events. Clerk provides human authentication. Stripe billing
and paid file workflows are scheduled for later phases. Sentry plus
service-native logs cover observability.

## Self-Hosting

Agent Outbox is source-available and can be self-hosted from this repository for
noncommercial uses. The same application boundary supports local development and
production operation with configured Cloudflare, Supabase, Clerk, Stripe,
Sentry, and secret-store resources.

## Contributing

Bug reports, feature requests, and implementation discussion belong in GitHub
Issues for this repository.

Contributions should preserve the core boundary: Agent Outbox owns review
lifecycle and typed delivery; callers own domain-specific source systems and
execution.

## License

Agent Outbox is released under the PolyForm Noncommercial License 1.0.0.
Commercial use requires separate permission from the licensor. See
[LICENSE](LICENSE).
