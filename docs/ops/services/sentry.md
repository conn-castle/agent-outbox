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

## Safe Checks

- Verify the configured organization and project before inspecting production.
- Use Sentry CLI for unresolved issue inspection, release checks, and
  source-map-related diagnostics.
- Until a stable Sentry CLI release includes upstream PR #3352, do not use
  `sentry-cli organizations list`: Sentry's current organization response makes
  the pinned CLI fail to deserialize. Obtain the organization slug from its
  Sentry dashboard URL and pass it explicitly to commands, for example
  `pnpm run sentry -- issues list`.
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
- During release verification, confirm whether source-map upload is
  intentionally enabled or disabled for the deploy path. Missing source maps are
  acceptable only when the owner accepts that posture for the release window.

## Guardrails

- Do not resolve, ignore, delete, or merge issues unless the task explicitly
  requires it.
- Do not upload or change source maps outside the configured build/deploy flow.
- Do not paste stack traces containing secrets, raw review content, uploaded
  filenames, or caller data into chat, issues, logs, or docs.
