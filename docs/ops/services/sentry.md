# Sentry

## Tool

Use the official Sentry CLI: `sentry-cli`.

Run `sentry-cli --help` first, then run command-specific help before using flags
that are not already proven in this repository.

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
  `sentry-cli issues list --org <organization-slug>`.
- Cross-check user-visible `error_id` values with Cloudflare Workers logs when
  investigating runtime failures.
- During release verification, confirm whether source-map upload is
  intentionally enabled or disabled for the deploy path. Missing source maps are
  acceptable only when the owner accepts that posture for the release window.

## Guardrails

- Do not resolve, ignore, delete, or merge issues unless the task explicitly
  requires it.
- Do not upload or change source maps outside the configured build/deploy flow.
- Do not paste stack traces containing secrets, raw review content, uploaded
  filenames, or caller data into chat, issues, logs, or docs.
