# Project Conventions

- **Packages (latest compatible stable versions):** Determine package versions using the package manager and official tooling/docs, not memory. Prefer the latest stable compatible versions. Avoid unstable or pre-release versions. If the latest stable version introduces breaking changes, ask for confirmation and then do the compatibility work.

- **Schema safety:** Never modify the database schema via raw SQL or direct tool access. Always generate a proper migration file using the project's migration system, and ask the user to apply it.

- **UTC-only internals:** Store, compute, and transport time in UTC; local time display is presentation-only.

- **Documentation upkeep:** When you learn durable project behavior or find a docs gap/mistake, update the relevant `docs/` Markdown file(s). Skip ephemeral debugging notes and generic best practices.

- **No system Python:** Never use system Python. Always prefer the project virtual environment Python, and if no virtual environment exists, ask the user if you should create one.
