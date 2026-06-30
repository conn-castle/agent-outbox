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
canonical root targets maintained for current and future work.

- Install pinned project dependencies

```bash
make setup
```

Run from: repo root Prerequisites: Node `22.13.0` or newer with Corepack
available; CI provisions Node `24.18.0` before running this command. Notes: Uses
Corepack to cache pnpm `11.9.0`, then installs from the lockfile using
`corepack pnpm`. Project scripts run on pinned Node `24.18.0`. Fails when
Corepack cannot activate pnpm, package metadata is missing, or the lockfile
cannot be installed exactly.

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

Run from: repo root Prerequisites: `make setup` has completed. Notes: Starts
the Next.js development server for the single app/API origin on `.env` `PORT`
(default local template: `38000`). Provider-backed routes still fail loudly
when the matching `.env` values are absent.

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
the pinned formatter to tracked source and documentation covered by the
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
pinned TypeScript compiler for repository code. Fails on type errors,
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

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs
foundation consistency checks and an OpenNext Cloudflare build against the
checked-in Wrangler configuration. OpenNext invokes the repository's
`next:build` script internally. Fails when package metadata, lockfile state,
pinned toolchain data, or runtime build output drift from the canonical
manifest. Stop `make dev` before running this command because Next dev and
OpenNext production builds share generated `.next` output.

- Smoke check

```bash
make smoke
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs
bounded structural smoke checks only. This credential-free check verifies the
runtime proof file surface, Worker scheduled trigger wiring, environment
template, workflow safety, and out-of-scope product guard. It must not require
provider credentials, create runtime resources, deploy, or publish artifacts.

- Worker scheduled-event smoke check

```bash
make smoke-worker-scheduled
```

Run from: repo root Prerequisites: `make setup` and `make build` have completed.
Notes: Starts a local Wrangler `workerd` server with `--test-scheduled`, calls
the `/__scheduled` test endpoint, and verifies the scheduled canary log is
emitted through the Worker `scheduled` handler. This is credential-free and must
not deploy or mutate Cloudflare resources.

- Provider-backed runtime smoke check

```bash
make smoke-runtime
```

Run from: repo root Prerequisites: `make setup` has completed, a compatible
local app server is serving `APP_BASE_URL`, and `.env` contains real
development Clerk, Supabase/Postgres, and smoke-token values. Notes:
Calls the runtime canary routes for app load, caller bearer auth acceptance and
rejection, database transaction context, restricted app role posture, scheduled
trigger, structured log, and Sentry suppression. This command can run against
`make dev`, but that proves only the local Next.js server path; Phase 2 still
requires a Workers/OpenNext runtime smoke proof before completion. Runtime smoke
must not emit Sentry events. Fails loudly with missing variable names when
`.env` is incomplete and must not print secret values.

- Single local and CI verification gate

```bash
make check
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Canonical
credential-free verification gate for local development and CI. It runs the
configured format, lint, typecheck, test, OpenNext build, local Worker
scheduled-event smoke, and structural smoke checks. Fails on any check failure
or on missing toolchain/package/runtime proof configuration. Stop `make dev`
before running this command because the OpenNext build writes the same generated
output tree as local Next dev.

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
PORT
APP_BASE_URL
PUBLIC_APP_BASE_URL
DATABASE_URL
DATABASE_APP_ROLE_URL
DATABASE_MIGRATION_URL
SUPABASE_PROJECT_REF
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
STRIPE_ACCOUNT_ID
SENTRY_DSN
SENTRY_BROWSER_DSN
SENTRY_AUTH_TOKEN
CALLER_KEY_HASH_SECRET
SMOKE_OR_CLEANUP_TOKEN
```

Notes: Stripe billing variables (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PAID_MONTHLY_PRICE_ID`, and
`STRIPE_BILLING_PORTAL_CONFIGURATION_ID`) are present in `.env.example` but are
not required until the billing phase creates products, prices, portal
configuration, and webhooks.

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
