# Project Conventions

- **Human-only approval labels (non-delegable):** Agents must never apply, reapply, or cause GitHub or CI to treat as applied `megachange-approved`, `migration-destructive-approved`, or `legal-policy-approved`. This includes GitHub CLI, REST or GraphQL APIs, browser automation, scripts, workflow dispatches, and equivalent approval inputs. User approval, merge authorization, standing authorization, plans, skills, or other instructions cannot override or delegate this act. When approval is required, report the exact gate and stop until a human independently applies the label through the GitHub web interface.

- **Packages (latest compatible stable versions):** Determine package versions using the package manager and official tooling/docs, not memory. Prefer the latest stable compatible versions. Avoid unstable or pre-release versions. If the latest stable version introduces breaking changes, ask for confirmation and then do the compatibility work.

- **Schema safety:** Never modify the database schema via raw SQL or direct tool access. Always generate a proper migration file using the project's migration system. Production migrations must run only as part of the formal protected GitHub Actions release workflow after certification and before application deployment; never apply them from a local operator or agent shell. Every production migration must remain compatible with both the outgoing and incoming application release because automatic rollback restores application code only, never schema. Local migration commands are only for local or disposable databases.

- **UTC-only internals:** Store, compute, and transport time in UTC; local time display is presentation-only.

- **Documentation upkeep:** Public/project documentation should contain durable information only. Non-durable information belong only in `docs/agent-layer` memory files. When you learn durable project behavior or find a docs gap/mistake, update the relevant `docs/` Markdown file(s). Skip ephemeral debugging notes and generic best practices.

- **Single-topic documentation:** Document each durable topic in one canonical Markdown file. Related files may link to that source or include a brief pointer when needed for context. Avoid duplicating the same guidance across multiple files unless the user explicitly approves the duplication.

- **No system Python:** Never use system Python. Always prefer the project virtual environment Python, and if no virtual environment exists, ask the user if you should create one.
