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
- Cross-check user-visible `error_id` values with Cloudflare Workers logs when
  investigating runtime failures.

## Guardrails

- Do not resolve, ignore, delete, or merge issues unless the task explicitly
  requires it.
- Do not upload or change source maps outside the configured build/deploy flow.
- Do not paste stack traces containing secrets, raw review content, uploaded
  filenames, or caller data into chat, issues, logs, or docs.
