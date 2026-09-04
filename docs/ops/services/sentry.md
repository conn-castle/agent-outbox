# Sentry

## Tool

Use the official Sentry CLI through the repository wrapper:

```bash
pnpm run sentry -- --help
```

The wrapper reads the auth token, organization slug, and project slug directly
from their canonical production SSM parameters with AWS SSO profile `conn` and
injects them only into the child process. It does not print or cache values.

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
- Next.js request-parser failures use `operation=next_request_error` and add
  low-cardinality `error_id`, `path_shape`, `multipart_boundary`, and
  `content_length_state` tags plus matching `agent_outbox` context. After a
  recurrence, inspect events with `pnpm run sentry -- events list --show-tags`
  and match the Worker log row by `error_id`. `path_shape=contains_dot` means
  the original path would skip the dotted-path middleware matcher.
  `multipart_boundary=absent` is a multipart request with no boundary parameter;
  `quoted` or `unquoted` means a boundary was declared. These fields never
  include the raw path, boundary token, query, headers, or body.
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
