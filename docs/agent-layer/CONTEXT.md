# Context

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose
Persistent project-specific knowledge that does not belong in ISSUES, BACKLOG, DECISIONS, or COMMANDS. Read this file before starting work on a task.

Record three categories of information here:
1. **Project context** — domain concepts, architectural invariants, naming conventions, external dependencies, environment setup notes, team norms, and any other stable facts an agent needs to work effectively in this repository.
2. **Project-specific nuances** — non-obvious behaviors, implicit conventions, or user-provided clarifications that an agent would not discover from reading the code alone. When a user corrects a misunderstanding or explains how something actually works in this project, record it here.
3. **Lessons learned** — repeated mistakes, surprising behaviors, non-obvious gotchas, and corrective patterns discovered during development. When an error recurs or a workaround is needed more than once, record it here so future agents avoid the same mistake.

Do not duplicate information that belongs in other memory files:
- Deferred bugs or tech debt → ISSUES.md
- Planned features → BACKLOG.md
- Workflow commands → COMMANDS.md
- Non-obvious decisions → DECISIONS.md

## Format
- Organize by topic using headings (`##`, `###`).
- Prefer concise bullet points. State facts directly; omit hedging language.
- Before adding an entry, search this file for existing coverage. Merge into or update an existing section instead of creating a near-duplicate.
- Remove or update entries when the underlying facts change.
- Insert all content below `<!-- ENTRIES START -->`.

<!-- ENTRIES START -->

## Agent Tooling

- `al dispatch` supports concurrent invocations: multiple reviewers/second-agents
  may be launched in parallel after live option validation. The old bug that
  required serialization is fixed; for review-agent fanout workflows such as
  `multi-agent-plan-review`, launch requested reviewers concurrently instead of
  serializing them.

### Required UI completion gate (user instruction, verbatim)

Every time you believe you are done, I want you to do the following:

1. Dispatch to claude opus high, and ask it if the /apple-design skill is being followed. And to have it call out any deviations for you to fix.
2. Dispatch to antigravity, claude opus high, codex terra xhigh, and ask them all if this follows best UI practices and if there are any obvious UI/UX issues. You should send them only PNGs. Send them 4 PNGs, each with different page widths. No more. No less.

Only once #1 and all agents from #2 say that the version is ready for me to review based on the above items, are you to tell me to review the page.

## Provider Setup

- AWS Systems Manager Parameter Store is the canonical Agent Outbox store for
  managed, recoverable secrets and environment-owned provider configuration.
  Local access uses AWS SSO profile `conn`; stable parameter names live below
  `/agent-outbox/environments/<stage>/` and `/agent-outbox/shared/`.
- Tracked docs should keep provider ids, account ids, project refs, database
  hosts, individual parameter names, current environment posture, and secret
  values out of public Markdown unless an operator runbook requires a stable
  non-secret name.
- GitHub uses `conn-castle/agent-outbox`.
- Cloudflare setup separates local Wrangler OAuth, DNS management tokens,
  Worker deploy tokens, and token-management credentials by purpose.
- Production Cloudflare Workers database access uses a Cloudflare Hyperdrive
  binding named `AGENT_OUTBOX_DATABASE` against the restricted Supabase app role;
  normal local/Node execution continues to use `DATABASE_APP_ROLE_URL`.
- Stripe billing uses account-scoped checkout, Billing Portal sessions, signed
  webhooks, and a database webhook idempotency ledger. Keep tracked docs free of
  provider account ids, customer ids, subscription ids, price ids, webhook ids,
  and secret values.
- Sentry is the error-monitoring provider for the Next.js app. Its organization,
  project, and credential values come from SSM and are injected into operator
  commands by `scripts/run-with-ssm-secrets.mjs`.
