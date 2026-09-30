# Context

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose

Persistent project-specific knowledge that does not belong in ISSUES, BACKLOG,
DECISIONS, COMMANDS, canonical repository documentation, or the implementation.
Read this file before starting work on a task.

Record only facts, nuances, or lessons that an agent needs across sessions and
cannot reasonably discover from the repository's canonical documentation,
code, tests, schemas, or configuration.

Do not duplicate information that belongs elsewhere:

- Current architecture or product behavior → repository documentation
- Enforceable behavior or invariants → code, tests, schemas, or configuration
- Otherwise-lost rationale that constrains future work → DECISIONS.md
- Deferred bugs or tech debt → ISSUES.md
- Planned features → BACKLOG.md
- Workflow commands → COMMANDS.md

## Format

- Organize by topic using headings (`##`, `###`).
- Prefer concise bullet points. State facts directly; omit hedging language.
- Before adding an entry, search the repository for existing coverage. Update
  the canonical source instead of copying it here.
- Remove or update entries when the underlying facts become documented,
  implemented, or no longer apply.
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
- The shared Homebrew tap GitHub App is the exception to the Agent Outbox path:
  its canonical `conn` / `us-east-1` parameters are
  `/conn-castle/homebrew-tap/github-app-id` and
  `/conn-castle/homebrew-tap/github-app-private-key`. Repository Actions secrets
  in `homebrew-tap`, `agent-layer`, `personal-context`, and `agent-outbox` are
  mirrors. The old `/personal-context/homebrew-tap-app-*` parameters are
  retained legacy mirrors because unknown consumers may still depend on them.
- `v0.2.6` is the first public Homebrew CLI release. Exact release archives and
  checksums come from GoReleaser; Agent Outbox owns deterministic cask rendering
  and validates Ruby/Homebrew style before production deployment.
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
