# Commands

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose
Canonical, repeatable **development workflow** commands for this repository (setup, build, run, test, coverage, lint/format, typecheck, migrations, scripts). This file is not for application/CLI usage documentation.

## Format
- Prefer commands that are stable and will be used repeatedly. Avoid one-off debugging commands.
- Organize commands using headings that fit the repo. Create headings as needed.
- If the repo is a monorepo, group commands per workspace/package/service and specify the working directory.
- When commands change, update this file and remove stale entries.
- Insert entries (and any needed headings) below `<!-- ENTRIES START -->`.

### Entry template
````text
- <Short purpose>
```bash
<command>
```
Run from: <repo root or path>
Prerequisites: <only if critical>
Notes: <optional constraints or tips>
````

<!-- ENTRIES START -->

## Repository Foundation

- Show the root command surface

```bash
make help
```

Run from: repo root Prerequisites: `make` must be available. Notes: Lists the
canonical root targets maintained for Phase 1 and later work.

- Install pinned project dependencies

```bash
make setup
```

Run from: repo root Prerequisites: Node `22.13.0` or newer with Corepack
available; CI provisions Node `24.18.0` before running this command. Notes: Uses
Corepack, pnpm `11.9.0`, `devEngines.runtime`, and the lockfile. Project scripts
run on pinned Node `24.18.0`. Fails when Corepack cannot activate pnpm, package
metadata is missing, or the lockfile cannot be installed exactly.

- Bootstrap the repo

```bash
make bootstrap
```

Run from: repo root Prerequisites: Same as `make setup`. Notes: Alias for
`make setup`; use it when a workflow calls the initial setup step "bootstrap."

- Run local prerequisite and provider diagnostics

```bash
make doctor
```

Run from: repo root Prerequisites: `make setup` has completed; `.env` exists;
required provider CLIs are installed and authenticated when provider checks are
expected to pass. Notes: Checks pinned local tools, required environment
variable names, and read-only provider authentication. It may fail on an
otherwise healthy checkout when secrets or provider logins are intentionally
absent. It must report missing variable names and setup actions without printing
secret values or provider account output.

- Start local development

```bash
make dev
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Phase 1
does not include a runtime app server. Until Phase 2 creates the app boundary,
this command is expected to fail loudly instead of starting a placeholder
runtime.

- Apply safe automatic fixes

```bash
make fix
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs
configured safe formatting or autofix steps only. It must not create provider
resources, mutate external services, or perform schema changes.

## Verification Gates

- Format files

```bash
make format
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Applies
the pinned formatter to tracked source and documentation covered by the Phase 1
formatter config.

- Lint check

```bash
make lint
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs
repository lint checks, including Markdown lint where configured. Fails on lint
violations, missing lint configuration, or dependency setup failures.

- Type check

```bash
make typecheck
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs the
pinned TypeScript compiler for Phase 1 tooling code. Fails on type errors,
missing TypeScript configuration, or package/toolchain drift.

- Test

```bash
make test
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs the
pinned Node built-in test runner. Tests should cover behavior that matters,
including toolchain/package consistency and secret-safe diagnostics.

- Build or structural verification

```bash
make build
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs Phase
1 build or structural consistency checks. Fails when package metadata, lockfile
state, or pinned toolchain data drift from the canonical manifest.

- Smoke check

```bash
make smoke
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs
bounded structural smoke checks only. Phase 1 smoke checks must not require
provider credentials, create runtime resources, deploy, or publish artifacts.

- Single local and CI verification gate

```bash
make check
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Canonical
credential-free verification gate for local development and CI. It runs the
configured format, lint, typecheck, test, build, and smoke checks. Fails on any
check failure or on missing Phase 1 toolchain/package configuration.

- Release verification gate

```bash
make release-check
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Canonical
non-publishing release/package verification gate. It may include stricter
packaging checks than `make check`, but it must not deploy, publish, tag, upload
packages, mutate provider state, or require private provider credentials.

## Maintenance

- Remove reproducible generated artifacts

```bash
make clean
```

Run from: repo root Prerequisites: `make` must be available. Notes: Bounded
cleanup only. It removes common reproducible build outputs. It must not remove
`.env`, source files, docs, provider configuration, `.agent-layer`, user data,
dependency directories, tool caches, or lockfiles.

## Environment Expectations

- Local secrets file

```bash
cp .env.example .env
```

Run from: repo root Prerequisites: None. Notes: `.env.example` is the tracked
template; `.env` is local-only and must not be committed. `make check` is
credential-free and should not require `.env`. `make doctor` requires `.env`
when validating local/provider readiness.

- Required local environment variable names

```text
APP_ENV
APP_BASE_URL
PUBLIC_APP_BASE_URL
DATABASE_URL
DATABASE_APP_ROLE_URL
DATABASE_MIGRATION_URL
SUPABASE_PROJECT_REF
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PAID_MONTHLY_PRICE_ID
STRIPE_BILLING_PORTAL_CONFIGURATION_ID
SENTRY_DSN
SENTRY_BROWSER_DSN
SENTRY_AUTH_TOKEN
CALLER_KEY_HASH_SECRET
SMOKE_OR_CLEANUP_TOKEN
```

Run from: repo root Prerequisites: Use `.env.example` as the source for required
names. Notes: Diagnostics may print missing names but must not print configured
values.

## CI

- GitHub Actions CI gate

```bash
make setup
make check
```

Run from: GitHub Actions checkout root Prerequisites: Workflow provisions Node
`24.18.0` before running commands. Notes: `.github/workflows/ci.yml` runs these
commands with read-only repository permissions and no provider credentials by
default.

- GitHub Actions release-check gate

```bash
make setup
make release-check
```

Run from: GitHub Actions checkout root Prerequisites: Workflow provisions Node
`24.18.0` before running commands. Notes: `.github/workflows/release-check.yml`
runs these commands with read-only repository permissions. The workflow is
verification-only and has no deployment or package publication step.
