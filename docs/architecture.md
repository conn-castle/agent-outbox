# Agent Outbox Architecture

## Boundary

Agent Outbox is an asynchronous human-review queue for agent-prepared work.
Callers submit typed input items, humans review them in the web app, and Agent
Outbox writes typed output results for the originating caller.

Agent Outbox owns:

- review routing and temporary queue state;
- human decisions and output-result delivery;
- account-scoped limits, billing state, and cleanup;
- content-safe audit and quota/accounting records.

Callers own source-system reads, writes, freshness checks, retries,
reconciliation, and downstream side effects.

Rationale: Agent Outbox should stay a generic review and delivery system, not a
source-system mirror, durable archive, workflow engine, or task backend.

## Runtime Shape

Hosted Agent Outbox has one deployable app boundary:

- **Runtime:** one Next.js app deployed to Cloudflare Workers through OpenNext.
- **Public website:** `https://agent-outbox.dev`.
- **Hosted app/API:** `https://app.agent-outbox.dev`, including `/api/...`
  caller routes.
- **Caller contract:** raw HTTP is canonical; the Go `agent-outbox` CLI is the
  first client and must map directly to the HTTP contract.
- **Database:** Supabase Postgres stores product state, queue rows, output rows,
  uploaded file bytes, quota windows, active limit blocks, and audit events.
- **Human auth:** Clerk.
- **Billing:** Stripe, scoped to Agent Outbox accounts.
- **Observability:** Sentry, Cloudflare native logs, Supabase native logs, and
  Cloudflare Web Analytics.
- **Secret recovery:** AWS Systems Manager Parameter Store. Service-native
  secret stores remain the runtime injection path.

The single deployable app still has hard internal boundaries: human UI server
code, caller API code, registration flows, storage access, authorization,
limits, billing, and maintenance jobs should stay separable.

Production runs on Cloudflare Workers/OpenNext against production service
resources. There is no persistent staging environment, so production deploys
need a focused smoke checklist.

## Trust Boundaries

Human routes use Clerk sessions and Agent Outbox account membership. The hosted
product ships owner-level access, but authorization must flow through account
membership so future roles can reuse the same model. Hosted production protected
routes fail closed when Clerk configuration is incomplete; explicit test fixture
bypasses are the only middleware bypass.

Caller routes use only Agent Outbox caller API keys. Caller endpoints must not
trust Clerk session state. Browser code must not access product tables directly.
Hosted connect, rotate, and revoke per-IP control-plane limits trust only
Cloudflare's `CF-Connecting-IP` header. `X-Forwarded-For` is not trusted on the
hosted path; non-Cloudflare self-hosting needs an explicit future proxy policy
before relying on forwarded client IP headers.

Canonical product ids:

- `account_id`: account, billing, limit, and queue namespace.
- `user_id`: Agent Outbox human user mapped from a Clerk identity.
- `caller_id`: one account-owned integration.

Provider ids map into Agent Outbox ids; they are not product primary keys.
Caller-provided labels, row types, action values, display names, and slugs are
data, not authorization scopes.

Caller API keys are long-lived bearer credentials bound to one account and
caller. The server derives account and caller identity from the key. Plaintext
keys are display-once; the database stores lookup metadata and a server-side
keyed hash.

Database authorization is hybrid:

- app-layer authorization is the product contract;
- Row Level Security protects product tables and views in exposed schemas;
- normal product requests use a restricted non-bypass Postgres role;
- server-only code sets transaction-local request context before touching rows;
- bypass credentials are reserved for migrations, repair, cleanup, and narrow
  internal operations;
- security-definer bootstrap functions that create initial account membership
  are owned by the bypass-capable migration owner under forced Row Level
  Security, while the restricted application role only receives execute.

## Data Authority

Canonical data sources:

- **Live queue/file rows:** pending inputs, answered inputs, unacknowledged
  outputs, attached files, and currently stored bytes.
- **Quota window counters:** fixed-window limits and rate limits that count
  consumed events after live rows may be gone.
- **Audit events:** append-only lifecycle history, content-safe usage history,
  and durable byte accounting.
- **Active limit blocks:** derived denial cache for already-blocked operations.

Active limit blocks explain a denial; they do not replace live rows, quota
windows, or audit events as sources of truth.

Storage rules:

- Preserve the typed product shape in relational tables instead of storing each
  review item as one opaque blob.
- Store input scalar fields plus child rows for links, actions, and popup
  options.
- Store output envelope fields plus popup-specific payload.
- Store output file metadata, digest, byte counts, linkage, and bytes in output
  file rows.
- Enforce current stock usage from indexed live rows and stored size columns.
- Enforce historical flow usage from quota windows.
- Do not add mutable current-usage tables or analytics rollups until a measured
  read path needs a derived optimization.

Audit events must not store review HTML, titles, summaries, details, free-text
answers, file bytes, caller API keys, full request bodies, or raw
caller-controlled display strings.

## Queue And Delivery

Agent Outbox has two Postgres-backed queues:

- **Input queue:** caller-to-human review state.
- **Output queue:** Agent-Outbox-to-caller delivery state.

Delivery is request/response polling. Supabase Realtime, Supabase Queues,
WebSockets, server-sent events, long polling, held-open requests, and background
push delivery are outside the delivery contract.

Input rules:

- Live state is `pending` or `answered`.
- `input send` is retry-safe create and never implicitly replaces a live item.
- `input replace` is the explicit pending-content update operation.
- Caller delete applies only to pending items.
- Answered items stay tied to their unacknowledged output until acknowledgement,
  pre-read undo, or timeout cleanup resolves the pair.
- Priority is a sortable queue field, not a scheduler.

Output rules:

- A human answer creates exactly one output result for the originating caller.
- Output check is non-mutating readiness metadata.
- Output read returns full payloads and marks returned results as read.
- Human undo is allowed only before caller read.
- Delivery is at least once until acknowledgement.
- `output_result_id` is the caller idempotency key.
- Acknowledgement is idempotent and deletes the output result, attached file
  rows/bytes, and matching input item in one logical operation.

Cleanup, retention, output-timeout deletion, acknowledged-output deletion,
quota-window pruning, and limit-block maintenance are idempotent database-backed
jobs. The architecture does not rely on an always-running process.

## File Handling

Hosted file uploads are part of the output-result path, not a general file
storage product.

Rules:

- Free hosted accounts cannot queue file-upload actions.
- Paid hosted accounts can upload files subject to the shared limits model.
- Uploaded file bytes are stored in Supabase Postgres.
- Output reads return file metadata only.
- File bytes are served through a dedicated caller-authorized download route.
- Upload/download routes are server-only Cloudflare Workers/OpenNext routes.
- File routes enforce raw-byte safety limits before storage and avoid unsafe
  whole-request buffering.
- File bytes, request bodies, free-text responses, and uploaded filenames where
  avoidable stay out of normal logs and output-read payloads.

Supabase Storage or another object store is future work only if Postgres storage
becomes the measured constraint.

## Limits, Billing, And Cleanup

Hosted billing and limits are account-scoped. Agent Outbox has a free hosted
tier and an initial Stripe-backed paid tier. Billing is not scoped to callers or
individual human seats.

One tier-aware limits structure should drive:

- product caps and runtime safety guards;
- quota names, reset rules, and error metadata;
- account/caller status and doctor output;
- UI copy;
- cleanup, retention, and active limit blocks.

Do not represent disabled paid-tier caps as hidden large numbers. Mark them as
disabled or not applicable.

Limit enforcement:

- Flow limits and fixed-window rate limits use quota window counters.
- Current queue counts and stored-byte limits use live rows and stored size
  columns.
- Active limit blocks cache denial outcomes.
- Cleanup operations remain available where needed to free storage or remove
  handled output.

Billing grace, downgrade cleanup, retention cleanup, output-timeout cleanup, and
acknowledgement cleanup use the same queue/file deletion path. Cleanup deletes
whole queue items, output results, and files; it does not partially trim
content.

Stripe checkout and Billing Portal sessions are created only for Clerk-backed
humans with Agent Outbox account membership. Stripe webhooks use raw-body
signature verification and a small idempotency ledger that stores event ids,
types, processing status, timestamps, and optional account linkage only. The
database remains the canonical source for app tier and billing status after
webhook synchronization.

## Human Review Surface

The web UI is a generic renderer over the typed input model and queue state. It
may provide list/detail loading, search, filters, sorting, bounded rendering,
primary/overflow actions, narrow bulk actions, and front-end-only skipped
ordering.

Rules:

- Humans authenticate through Clerk and resolve to Agent Outbox-owned user,
  account, and membership ids before any queue reads or writes.
- Do not hardcode caller-specific source semantics or downstream execution.
- Skipped state is presentation-only; it is not backend lifecycle state and does
  not create output.
- Browser rendering trusts only already-sanitized typed fields from server-only
  queue reads. Unsafe colors are ignored at render time, unsupported icons use a
  fixed fallback, unsafe links are omitted, and caller-provided component,
  script, arbitrary SVG/media, or form attempts remain data instead of UI code.
- Human answers, pre-read undo, and narrow compatible bulk actions use
  server-only writes. Bulk answer forms are capped at 100 unique input items,
  matching the maximum review list page size. Undo is unavailable after a caller
  read marks the output.
- Business rules, authorization, quota checks, queue writes, output delivery,
  and file handling belong in server-only code and the database.

## Operational Interfaces

Architecture-level responsibilities:

- AWS Systems Manager Parameter Store is the durable recovery source for hosted
  secrets; service-native secret stores hold runtime values.
- Unexpected or operator-actionable failures get a stable `error_id` shared by
  structured logs and Sentry.
- Logs, audit events, and frontend telemetry are content-safe.
- Provider-native logs and dashboards are the default operational surfaces.
- Agent Outbox stores temporary queue data and does not add custom backups of
  queue content or uploaded bytes.

## Runtime Integration Requirements

The hosted runtime must support these integration boundaries:

- Next.js and provider-backed app routes in the app test/runtime path.
- OpenNext, Wrangler, and `workerd` only in explicit Cloudflare deployment or
  platform verification paths, not in the normal app CI gate.
- Clerk sign-in, sign-out, server-side user lookup, and protected routes.
- Caller bearer authentication and human-approved caller registration.
- Direct Postgres access through the restricted non-bypass role with explicit
  transactions and transaction-local Row Level Security context.
- Idempotent scheduled cleanup without an always-running process.
- Server-only paid file upload/download in the deployed runtime, including
  free-tier rejection, raw-byte cap enforcement, Postgres storage, metadata-only
  output reads, and authorized raw-byte download.
- Correlated Sentry and structured native-log canary records.

The project uses a tracked Worker wrapper entrypoint for Cloudflare Workers.
HTTP requests delegate to OpenNext's generated Worker output; scheduled events
run through the project-owned Worker `scheduled` handler. That platform wiring
is verified by explicit Cloudflare checks, separate from app tests.
