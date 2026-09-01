# Agent Outbox

> Status: Agent Outbox is under active development. Its macOS and Linux CLI is
> publicly available through the direct installer and Homebrew, and hosted
> caller connection is available through browser approval.

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

This repository is public and source-available under the
[PolyForm Perimeter License 1.0.1](LICENSE). The `agent-outbox` CLI is available
for public installation on macOS and Linux, and anyone can connect a caller to
their hosted account through the browser-approved CLI flow. The hosted service
uses:

- `https://agent-outbox.dev` for the product landing page and API documentation
- `https://app.agent-outbox.dev` for the human app and caller API

The current repository implements:

- Clerk-backed sign-up, sign-in, sign-out, and a protected human review queue UI
- Account-scoped callers and display-once API credentials
- Caller-authenticated raw HTTP status, input, output, acknowledgement, and
  output-file download routes
- A Go `agent-outbox` CLI for caller setup, caller/account status, input,
  output, diagnostics, terminal docs, upgrade URL opening, and version metadata
- GoReleaser package verification plus post-deploy automation that attaches
  tagged CLI archives to the numbered GitHub release and opens a guarded
  Homebrew tap cask PR
- Free-tier queue caps, caller limits, retention primitives, cleanup primitives,
  and runtime canaries
- Account-scoped Stripe checkout, billing portal, webhook idempotency, billing
  grace state, and scheduled downgrade cleanup foundations
- Paid/self-hosted file-upload inputs, human upload answers, metadata-only
  output reads, caller-authorized raw-byte downloads, and Postgres-backed file
  deletion audit paths
- Sentry, Cloudflare, and Supabase/Postgres-backed observability foundations

The hosted service has one deployable app and two hostnames. Caller API routes
live under `https://app.agent-outbox.dev/api/...`.

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

Install the public CLI:

```bash
brew install --cask conn-castle/tap/agent-outbox
```

Or install the latest macOS or Linux release directly without Homebrew or
`sudo`:

```bash
curl -fsSL https://agent-outbox.dev/install.sh | sh
```

The direct installer detects amd64 or arm64, verifies the published release
checksum, and installs to `~/.local/bin`. Set `AGENT_OUTBOX_INSTALL_DIR` to use
another user-writable directory.

Connect a caller, then approve it in the browser:

```bash
agent-outbox caller connect my-agent
```

`my-agent` is a local label you choose. The command opens Agent Outbox so a
signed-in person can review and approve the caller. The CLI then stores the
display-once credential in its owner-only local credentials file.

For repository development, set up the current checkout:

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

Build the local `agent-outbox` CLI:

```bash
make go-build
dist/agent-outbox --help
```

Connect a local caller through human approval, then submit and read work:

```bash
dist/agent-outbox caller connect steward-email
dist/agent-outbox input send --file input.json
dist/agent-outbox output check
dist/agent-outbox output read --all
```

Raw HTTP remains the canonical integration contract in [docs/spec](docs/spec).
The CLI maps to that HTTP contract and adds local-only utilities such as `docs`,
`doctor`, `upgrade`, and `version`.

The branded public guides at `/docs/api` combine intentionally written
integration guidance with a generated OpenAPI 3.1 reference. The executable
public contract lives in `src/shared/public-api-contract.ts`; generated
artifacts are checked for drift during normal builds.

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
- Paid/self-hosted file-upload actions with free-tier upgrade-required rejection

Example:

```json
{
  "caller_item_id": "email:thread_123",
  "priority": "high",
  "row_type": {
    "display": "Email Draft",
    "icon": "mail"
  },
  "row_accent_color": "blue",
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
    "color": "orange"
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
- `GET /api/input/list` enumerates live retained input metadata.
- `POST /api/input/read` returns one live canonical accepted input.
- Answered items stay visible until the caller acknowledges the matching output
  result or retention cleanup resolves it.
- Human undo is available before the caller reads the output result.
- `GET /api/output/check` is non-mutating readiness metadata.
- Output read routes return full output payloads, including canonical
  `raw_input`, and mark returned results as read.
- `POST /api/output/{output_result_id}/ack` is idempotent after caller-side
  durable handling.

Delivery is asynchronous and at least once. Callers deduplicate by
`output_result_id`.

## Caller Integration

Raw HTTP is the canonical integration contract. The `agent-outbox` CLI maps
directly to the HTTP API for caller setup, status, input writes, output, and
acknowledgement while keeping local utilities local-only.

Implemented caller-authenticated HTTP areas:

- `GET /api/caller/status` for caller health and account limit metadata
- `GET /api/account/status` for account status using existing caller credentials
- `POST /api/input/send`, `POST /api/input/replace`, `POST /api/input/delete`,
  `GET /api/input/list`, and `POST /api/input/read`
- `GET /api/output/check`, `POST /api/output/{output_result_id}/read`,
  `POST /api/output/read-all`,
  `GET /api/output/{output_result_id}/files/{file_id}`, and
  `POST /api/output/{output_result_id}/ack`

Implemented CLI areas:

- `caller connect/list/status/rotate/revoke/disconnect`
- `account status`
- `input send/list/read/replace/delete`
- `output check/read/read --all/file get/ack`
- `docs [topic]`, `doctor [--caller]`, `upgrade`, `version`, and `--version`

Billing behind the hosted upgrade page is implemented through Stripe checkout,
portal sessions, and signed webhooks. Paid/self-hosted file uploads use
Postgres-backed output-file rows and the dedicated caller-authorized download
route.

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
output results, paid upload file bytes, quotas, active limit blocks, and audit
events. Clerk provides human authentication. Stripe billing is account-scoped
through checkout, portal sessions, and signed webhooks. Sentry plus
service-native logs cover observability.

## Self-Hosting

Agent Outbox is source-available and can be self-hosted from this repository for
internal use, including commercial internal operations, under the
[PolyForm Perimeter License 1.0.1](https://polyformproject.org/licenses/perimeter/1.0.1).
You may not provide others a product that competes with Agent Outbox, including
a competing hosted service. The same application boundary supports local
development and production operation with configured Cloudflare, Supabase,
Clerk, Stripe, Sentry, and secret-store resources.

Self-hosted deployments are separate from the hosted service. Access to hosted
free and paid plans remains governed by the
[Terms of Service](/terms-of-service) and their plan limits.

## Contributing

Bug reports, feature requests, and implementation discussion belong in GitHub
Issues for this repository.

Contributions should preserve the core boundary: Agent Outbox owns review
lifecycle and typed delivery; callers own domain-specific source systems and
execution.

## License

Agent Outbox is released under the [PolyForm Perimeter License 1.0.1](LICENSE).
It permits internal use and modification, including commercial internal
operations, but prohibits providing others a product that competes with Agent
Outbox, including a competing hosted service. The hosted free and paid services
remain governed by the [Terms of Service](/terms-of-service) and their plan
limits.

That license covers Agent Outbox itself. Third-party components vendored into
this repository stay under their own licenses and copyright holders; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
