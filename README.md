# Agent Outbox

> Status: Agent Outbox is under active development and has not been publicly released yet.

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

Use the public hosted service at:

- `https://agent-outbox.dev` for product documentation
- `https://app.agent-outbox.dev` for the review app, caller registration, and
  caller API

Hosted Agent Outbox includes:

- Clerk-backed human sign-in
- Account-scoped callers and API credentials
- A free hosted tier for capped queue usage
- A paid hosted tier for file-upload workflows
- Stripe billing and account status
- Sentry, Cloudflare, and Supabase-backed observability
- Strict limits, retention, and abuse controls for public use

The hosted service has one app/API origin. Caller API routes live under
`https://app.agent-outbox.dev/api/...`.

## How It Works

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

Install the CLI:

```bash
brew install agent-outbox
```

Connect a caller:

```bash
agent-outbox caller connect steward-email
```

Submit a review item:

```bash
agent-outbox input send --file review-item.json --caller steward-email
```

Check for completed human decisions:

```bash
agent-outbox output check --caller steward-email
```

Read completed output:

```bash
agent-outbox output read --all --caller steward-email --json
```

Acknowledge a handled result:

```bash
agent-outbox output ack <output_result_id> --caller steward-email
```

Run diagnostics:

```bash
agent-outbox doctor --caller steward-email
```

The CLI also includes terminal documentation:

```bash
agent-outbox docs
agent-outbox docs input
agent-outbox docs output
```

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
  datetime input, and file upload

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
- File metadata for uploaded files, when the action requested a file
- Delivery and read/acknowledgement metadata

File bytes are fetched through a dedicated authorized download command:

```bash
agent-outbox output file get <output_result_id> <file_id> --output receipt.pdf
```

Callers acknowledge results only after their own downstream handling is durable.
Acknowledgement removes the live queue pair from Agent Outbox.

## Queue Semantics

Agent Outbox uses two queues:

- **Input queue:** caller to Agent Outbox. Pending work visible to humans.
- **Output queue:** Agent Outbox to caller. Completed human decisions waiting
  for caller handling.

Important behavior:

- `input send` is retry-safe create.
- `input replace` explicitly updates a pending item.
- `input delete` removes only pending items.
- Answered items stay visible until the caller acknowledges the matching output
  result or retention cleanup resolves it.
- Human undo is available before the caller reads the output result.
- `output check` is non-mutating readiness metadata.
- `output read` returns full output payloads and marks returned results as read.
- `output ack` is idempotent after caller-side durable handling.

Delivery is asynchronous and at least once. Callers deduplicate by
`output_result_id`.

## Caller Integration

Raw HTTP is the canonical integration contract. The `agent-outbox` CLI maps
directly to the HTTP API and is the recommended integration surface for agents,
local services, and scripts.

Core CLI areas:

- `agent-outbox caller ...` for connection, listing, status, rotation,
  revocation, and disconnect
- `agent-outbox account status` for account, billing, tier, quota, and storage
  state
- `agent-outbox input ...` for sending, replacing, and deleting input items
- `agent-outbox output ...` for checking, reading, downloading files, and
  acknowledging results
- `agent-outbox doctor` for local config, auth, account, limit, and runtime
  diagnostics
- `agent-outbox docs`, `agent-outbox upgrade`, and `agent-outbox version`

Every noninteractive command supports `--json` for stable machine-readable
output. Data-plane commands are noninteractive by default.

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

The hosted product runs as one Next.js application on Cloudflare Workers through
OpenNext. Supabase Postgres stores accounts, callers, live queues, output
results, uploaded file bytes, quotas, active limit blocks, and audit events.
Clerk provides human authentication, Stripe provides billing, and Sentry plus
service-native logs cover observability.

## Self-Hosting

Agent Outbox is source-available and can be self-hosted from this repository
for noncommercial uses. The same application boundary supports local
development and production operation with configured Cloudflare, Supabase,
Clerk, Stripe, Sentry, and secret-store resources.

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
