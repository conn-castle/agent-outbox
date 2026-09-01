# Resolve Sentry Issues

This is one iteration of a repeated loop whose purpose is to clear actionable
unresolved issues from the `agent-panel` Sentry project, one PR at a time. Read
`docs/ops/systems/sentry.md`, `docs/ops/systems/axiom.md`, and
`docs/ops/DEBUGGING.md` before selecting work, and follow their current access,
query, correlation, shared-project, synthetic-traffic, release-health, and
post-release resolution guidance.

Refresh the complete unresolved inventory. Resolve synthetic issues and
already-deployed fixes only when they meet the documented ordinary-resolution
policy. From the remaining real errors, select the highest-value coherent
root-cause fix that fits in one PR and can be implemented without a human
decision, prioritizing current production impact and prerequisites. Corroborate
each selected Sentry issue with Axiom or local log evidence before changing
code. Leave merged fixes unresolved while they await the required deployment
evidence, and treat work already covered by an open PR as in flight.

Do not demote severity, suppress or filter capture, mute an issue, or reclassify
an event. Those actions require human approval. Preserve failure visibility and
fix the underlying defect. Stop only when a complete refreshed pass finds no
independently fixable issue; report anything waiting for deployment evidence or
blocked on a specific external or human condition.
