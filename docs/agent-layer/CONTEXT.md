# Context

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose
Persistent project-specific knowledge that does not belong in ISSUES, BACKLOG, ROADMAP, DECISIONS, or COMMANDS. Read this file before starting work on a task.

Record three categories of information here:
1. **Project context** — domain concepts, architectural invariants, naming conventions, external dependencies, environment setup notes, team norms, and any other stable facts an agent needs to work effectively in this repository.
2. **Project-specific nuances** — non-obvious behaviors, implicit conventions, or user-provided clarifications that an agent would not discover from reading the code alone. When a user corrects a misunderstanding or explains how something actually works in this project, record it here.
3. **Lessons learned** — repeated mistakes, surprising behaviors, non-obvious gotchas, and corrective patterns discovered during development. When an error recurs or a workaround is needed more than once, record it here so future agents avoid the same mistake.

Do not duplicate information that belongs in other memory files:
- Deferred bugs or tech debt → ISSUES.md
- Planned features → BACKLOG.md
- Workflow commands → COMMANDS.md
- Non-obvious decisions → DECISIONS.md
- Phased plans → ROADMAP.md

## Format
- Organize by topic using headings (`##`, `###`).
- Prefer concise bullet points. State facts directly; omit hedging language.
- Before adding an entry, search this file for existing coverage. Merge into or update an existing section instead of creating a near-duplicate.
- Remove or update entries when the underlying facts change.
- Insert all content below `<!-- ENTRIES START -->`.

<!-- ENTRIES START -->

## Provider Setup

- Exact provider inventory values belong in approved operator-controlled secret
  stores; tracked docs should keep provider ids, account ids, project refs,
  database hosts, secret-store paths, current environment posture, and secret
  values out of public Markdown.
- GitHub uses `conn-castle/agent-outbox`.
- Cloudflare setup separates local Wrangler OAuth, DNS management tokens,
  Worker deploy tokens, and token-management credentials by purpose.
- Phase 8 external-write checkpoints require explicit owner approval before
  Cloudflare Worker/domain/secrets/deploy actions, Stripe production
  domain/payment-method/runtime-key actions, GitHub branch protection changes,
  Sentry release/source-map uploads, and legal/business launch acceptance.
- Stripe billing uses account-scoped checkout, Billing Portal sessions, signed
  webhooks, and a database webhook idempotency ledger. Keep tracked docs free of
  provider account ids, customer ids, subscription ids, price ids, webhook ids,
  and secret values.
- Sentry is the error-monitoring provider for the Next.js app. Organization and
  project metadata belongs in approved operator-controlled systems, not tracked
  docs.
