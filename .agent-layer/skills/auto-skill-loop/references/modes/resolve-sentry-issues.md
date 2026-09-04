# Resolve Sentry Issues

This is one iteration of a repeated loop whose purpose is to clear actionable
unresolved issues from the Agent Outbox Sentry project, one PR at a time. Before
selecting work, read `docs/ops/services/sentry.md` and `docs/ops/monitoring.md`.
After selecting an issue, read `docs/ops/debugging.md` and the service runbook
for each relevant provider. Read `docs/ops/release.md` only when deciding
whether a fix has reached production. Follow those runbooks' current access,
data-safety, correlation, runtime-capture, source-map, and production-release
guidance.

Use the repository's `pnpm run sentry -- ...` wrapper for Sentry access and
verify its configured organization and project before triage. Refresh the
complete unresolved inventory, accounting for the `issues list` page and row
limits; if a limit is reached, use supported narrower queries until the full
inventory is represented. From real production errors, select the highest-value
coherent root-cause fix that fits in one PR and can be implemented without a
human decision, prioritizing current production impact and prerequisites.

Corroborate the selected issue with the matching Cloudflare Workers log by
`error_id`, route, operation, release, and UTC window when those fields are
available. Use the relevant provider or local evidence when the failure is not a
Worker runtime error. If the available evidence cannot establish the defect,
improve safe observability instead of guessing at a fix.

Treat work already covered by an open PR as in flight. Leave real issues
unresolved until the fix is deployed to production and current Sentry and
runtime evidence shows that release is serving without recurrence. Resolve
repo-owned smoke/canary issues only after confirming that they contain no real
failure and were produced by the documented Agent Outbox verification path.
Resolve issues only by explicit issue ID; never use `--all` or another bulk
selector for an issue-state mutation. Synthetic cleanup is triage, not the PR's
implementation task, so continue selecting work after resolving a canary issue.

Do not demote severity, suppress or filter capture, mute an issue, or reclassify
an event. Those actions require human approval. Preserve failure visibility and
fix the underlying defect. Stop only when a complete refreshed pass finds no
independently fixable issue; report anything waiting for deployment evidence or
blocked on a specific external or human condition.
