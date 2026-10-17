# Sentry

## Repository scope

This repository owns Sentry project **`agent-outbox`** in organization
**`conn-castle`**, with issue IDs prefixed **`AGENT-OUTBOX-`**. Error
inventories, triage, fixes, and issue-state changes in this repository must be
limited to that project. Do not query or change another project's issues, or
move implementation to a sibling repository, unless the user explicitly requests
that scope. Organization-wide credentials do not grant task authorization across
projects.

If a skill, dispatch prompt, or copied runbook names another project, treat it
as a scope mismatch and correct the task context before proceeding. Never
substitute a sibling repository's Sentry runbook or authentication mechanism
when access fails here. Include the project name in inventory reports so issue
counts cannot be mistaken for another app's.

## Tool

Use the official Sentry CLI through the repository wrapper:

```bash
pnpm run sentry -- --help
```

The wrapper reads the auth token, organization slug, and project slug directly
from their canonical production SSM parameters with AWS SSO profile `conn` and
injects them only into the child process. It does not print or cache values.

Sentry operator authentication is **SSM-backed only**. A missing `SENTRY_*`
variable in the parent shell is expected, not an authentication failure. Do not
create `~/.sentryclirc`, put Sentry credentials in `.agent-layer/.env` or
`.env.local`, or ask the user to export a token. Use the wrapper to test access:

```bash
pnpm run sentry -- info
pnpm run sentry -- issues list --project agent-outbox --query 'is:unresolved' --max-rows 100
```

Confirm `info` reports organization `conn-castle` and project `agent-outbox`. If
either differs, stop and report the configuration mismatch rather than querying
the configured foreign project. Use `--query 'is:unresolved'` to filter the
inventory; do not rely on `--status unresolved`, which can still return resolved
rows with the pinned CLI. Check returned statuses and account for row and page
limits before reporting a complete count.

If the wrapper reports an expired AWS SSO session, authenticate and retry:

```bash
aws sso login --profile conn --use-device-code --no-browser
```

For other SSM failures, report the wrapper's actionable error; do not fall back
to local Sentry secrets. See
[secrets.md](../secrets.md#direct-ssm-backed-operator-commands) for the
canonical secret-management workflow.

Run wrapper help first, then run command-specific help before using flags that
are not already proven in this repository.

## Owns

- Application exception grouping.
- Release records.
- Source maps.
- Issue triage and status.

## Event Content

Runtime Sentry init (`src/server/sentry.ts`) disables SDK breadcrumbs and
verifies SDK-derived exception frames in `preprocessEvent`, after LinkedErrors
resolves causes and AggregateError children and before processors such as Node's
ContextLines read source files. Each exception retains frames only when its
source stack starts with the error's exact name/message header (including the
code for Node's coded errors) followed by a newline; the client's SDK parser
parses the remaining frames. Synthetic inputs, unverifiable headers, and failed
source reads have no frames. When verification leaves an exception that had
SDK-parsed frames with none, the event gets `stack_frames=omitted`; an already
frameless exception does not necessarily get that tag. Explicit `captureEvent`
frames without original-exception metadata remain trusted as supplied.

The shared content scrubber runs in `beforeSend`/`beforeSendTransaction` and
again at the `beforeEnvelope` transport boundary. Internal SDK exceptions
receive early frame verification too, and transport scrubbing covers their
content even though they bypass event processors and `beforeSend`. The envelope
sampling header is scrubbed at that boundary too:

- Exception messages become `Agent Outbox runtime failure`; valid safe exception
  class names remain, while invalid names become `Error` using the logger's name
  validation. Retained stack frames (without local variables), allowed source
  context, and mechanisms remain.
- The raw `node_system_error` context is removed because it copies arbitrary
  original-error properties. Canonical reporter tags and `agent_outbox` context
  remain.
- Request data keeps only the HTTP method.
- `nextjs.request_path`, breadcrumbs, extras, and free-text message fields are
  removed.
- Span data loses request/response header, request body, and raw URL attributes.
- Database statement attributes (`db.statement`, `db.query.text`) and connection
  strings are removed from trace and span data. Database span descriptions and
  database root transaction names (including sampling headers) become
  `db.query`.
- Transaction names, span descriptions, and the transaction name in the envelope
  sampling header lose any query or fragment suffix.

## Source Maps

Release builds disable Sentry's Next.js source maps. The build plugin still
creates and finalizes `SENTRY_RELEASE` when the release upload gate is enabled.
During `upload-worker`, Wrangler bundles once with a source map in a private
temporary directory. `sentry-cli` injects one debug ID, then uploads `entry.js`
and its matching map as project artifact bundles with `--strict --wait`, without
release association. An injection, upload, identity, or byte-verification
failure stops the release before an inactive Worker version exists.

Wrangler then uploads those exact injected bytes in no-bundle mode, with
`upload_source_maps: false` explicitly set. Maps never become deployed assets
and are never sent to Cloudflare. Temporary bundles and maps are removed on
success and failure. See the [release flow](../release.md#production-deploy) for
the surrounding certification and deployment gates.

Worker-direct frames resolve to application TypeScript. **Next-routed frames
resolve only to OpenNext's `.open-next/server-functions/default/handler.mjs`**:
OpenNext emits no intermediate server-bundle map. Full TypeScript mapping for
those frames remains unavailable; see
[OpenNext issue #1352](https://github.com/opennextjs/opennextjs-cloudflare/issues/1352).

## Safe Checks

- Verify the configured organization and project before inspecting production.
- Use Sentry CLI for unresolved issue inspection, release checks, and
  source-map-related diagnostics.
- Cross-check user-visible `error_id` values with Cloudflare Workers logs when
  investigating runtime failures.
- Next.js request-parser failures use `operation=next_request_error` and add the
  high-cardinality `error_id` correlation tag alongside low-cardinality
  `path_shape`, `multipart_boundary`, and `content_length_state` tags plus
  matching `agent_outbox` context. After a recurrence, inspect events with
  `pnpm run sentry -- events list --show-tags` and match the Worker log row by
  `error_id`. `path_shape=contains_dot` means the original path would skip the
  dotted-path middleware matcher. `multipart_boundary=absent` is a multipart
  request with no boundary parameter; `quoted` or `unquoted` means a boundary
  was declared. These fields never include the raw path, boundary token, query,
  headers, or body.
- GitHub sign-in launch failures are grouped by the safe
  `client_event.github_sign_in_*` operation. Use the corresponding Cloudflare
  log row for the server-generated `error_id` and capture outcome. The server
  derives categories from event names, permits one capture attempt per Worker
  isolate per minute across all GitHub launch names, and never forwards browser
  messages or Clerk/provider text.
- During release verification, check the final Worker bundle identity and the
  Next-routed mapping limitation described in [Source Maps](#source-maps).

## Guardrails

- Do not resolve, ignore, delete, or merge issues unless the task explicitly
  requires it.
- Do not upload or change source maps outside the configured build/deploy flow.
- Do not paste stack traces containing secrets, raw review content, uploaded
  filenames, or caller data into chat, issues, logs, or docs.
