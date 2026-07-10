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

- Browser smoke test

```bash
make browser
```

Run from: repo root Prerequisites: `make setup` has completed and Playwright
Chromium has been installed with `corepack pnpm exec playwright install
chromium` if it is not already present; Docker must be running. Notes: Runs
deterministic desktop and mobile browser coverage through the test-only human
review fixture and caller-connect Clerk fixture, including signup handoff,
list/detail review, popup controls, skipped ordering, search/filter/sort,
narrow bulk compatibility, pre-read undo, no-undo-after-read state,
hostile-content rendering, and live caller-connect browser/device approval
against a disposable migrated `postgres:17` database. It starts a local Next.js
server with `APP_ENV=test`, `AGENT_OUTBOX_BROWSER_FIXTURE=1`, and
`AGENT_OUTBOX_CONNECT_CLERK_FIXTURE=1`; it must not require real Clerk or
provider credentials. The fixture bypasses the production Clerk path only when
the gate variables are set by the Playwright web server.

- Build the app

```bash
make build
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs
foundation consistency checks and a normal Next.js app build. This is an
app-level gate and must not require Wrangler, OpenNext Cloudflare, provider
credentials, deployment artifacts, or platform-specific runtime emulation.

- Smoke check

```bash
make smoke
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Runs
bounded structural smoke checks only. This credential-free check verifies the
runtime proof file surface, environment template, workflow safety,
implemented-route contract coverage, Worker cron schedule alignment, and
out-of-scope product guard. It must not require provider credentials, Wrangler,
OpenNext Cloudflare, platform emulators, deployment artifacts, or external
resource mutation.

- Provider-backed runtime smoke check

```bash
make smoke-runtime
```

Run from: repo root Prerequisites: `make setup` has completed, a compatible
app server is serving `APP_BASE_URL`, and the smoke environment contains real
Clerk, Supabase/Postgres, Sentry, caller-key hash, and smoke-token values.
Notes: By default this reads root `.env` for local development. For hosted
production smoke, set `AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE` to an
operator-controlled env file instead of replacing root `.env` with production
values. Calls the runtime canary routes for app load, caller bearer auth
acceptance and rejection, database transaction context, restricted app role
posture, scheduled trigger, structured log, and Sentry suppression. Runtime
smoke must not emit Sentry events. Fails loudly with missing variable names when
the selected env file is incomplete and must not print secret values.

- Hosted health inspection

```bash
make hosted-health
```

Run from: repo root Prerequisites: `make setup` has completed and a hosted app
is serving `APP_BASE_URL`. Notes: Reads `AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE`,
then `AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE`, then root `.env`. Runs smoke-safe
hosted checks for app/auth reachability, caller API auth, database canary,
scheduled cleanup canary, structured logs, and Sentry suppression. Quota, file
path, audit-event, and abuse/cost checks require content-safe operator evidence
markers (`AGENT_OUTBOX_HOSTED_HEALTH_*_EVIDENCE`) or return
`action_required`. Exit code `0` means all checks passed, `1` means at least one
check failed, and `2` means no check failed but operator action is required.
The command must not print secret values.

- Hosted billing smoke check

```bash
make billing-smoke
```

Run from: repo root Prerequisites: `make setup` has completed and a hosted app
is serving `APP_BASE_URL`. Notes: Reads `AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE`,
then `AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE`, then root `.env`. Verifies hosted
billing configuration and, when `AGENT_OUTBOX_BILLING_SMOKE_COOKIE` contains a
valid operator-provided Clerk session cookie, creates monthly/yearly Checkout
sessions and a Billing Portal session without completing payment. Full live
completion that creates subscription, charge, refund, cancellation, or downgrade
state requires a separate owner-approved protocol and is reported as
`action_required` by default. Exit code `0` means all checks passed, `1` means
at least one check failed, and `2` means no check failed but operator action is
required. The command must not print cookies or secret values.

- Single local and CI verification gate

```bash
make check
```

Run from: repo root Prerequisites: `make setup` has completed. Notes: Canonical
credential-free verification gate for local development and CI. It runs the
configured format, lint, typecheck, test, app build, and structural smoke
checks. It tests the app, not deployment platforms: it must not require
Wrangler, OpenNext Cloudflare, provider credentials, deployment artifacts, or
platform runtime emulation.

## Go CLI Foundation

- Build the Go CLI binary

```bash
make go-build
```

Run from: repo root Prerequisites: Go `1.26.4` must be available. Notes: Builds
the `agent-outbox` binary to `dist/agent-outbox` with build-time version
metadata and without requiring Node or Python at runtime.

- Run Go CLI unit tests

```bash
make go-test
```

Run from: repo root Prerequisites: Go `1.26.4` must be available. Notes: Runs
`go test ./...` from `cli/` for config, caller selection, base URL, exit-code,
deterministic/no-color output, secret-store, HTTP-client, caller control-plane,
data-plane, utility command, terminal-docs, doctor, upgrade, version, and help
behavior.

- Run Go CLI lint checks

```bash
make go-lint
```

Run from: repo root Prerequisites: Go `1.26.4` must be available. Notes: Runs
`go vet ./...` from `cli/`.

- Format Go CLI source

```bash
make go-fmt
```

Run from: repo root Prerequisites: Go `1.26.4` must be available. Notes: Applies
`gofmt` to Go source under `cli/`.

- Run the Go CLI verification gate

```bash
make go-check
```

Run from: repo root Prerequisites: Go `1.26.4` must be available. Notes: Runs a
non-mutating Go format check, `go vet`, Go unit tests, and the binary build to
`dist/agent-outbox`. CI and release-check workflows run this as a sibling gate;
the credential-free Node `make check` remains separate.

- Validate CLI package artifacts without publishing

```bash
make package-check
```

Run from: repo root Prerequisites: Go `1.26.4` must be available. Notes: Runs
pinned GoReleaser `github.com/goreleaser/goreleaser/v2@v2.16.0` through
`go run`, validates `.goreleaser.yaml`, and builds a local
`release --snapshot --clean` package set including Homebrew cask metadata under
`dist/homebrew/Casks/`. The GoReleaser config also sets cask `skip_upload:
true`. It must not publish, tag, upload, deploy, or require private provider
credentials.

- Release verification gate

```bash
make release-check
```

Run from: repo root Prerequisites: `make setup` has completed and Go `1.26.4`
must be available. Notes: Canonical non-publishing release/package verification
gate. It runs `make check`, `make go-check`, and `make package-check`. It must
not deploy, publish, tag, upload packages, mutate provider state, or require
private provider credentials.

## Cloudflare Platform

- Build the OpenNext Cloudflare Worker bundle

```bash
pnpm run worker:build
```

Run from: repo root Prerequisites: `make setup` has completed or pinned `pnpm`
dependencies are installed. Notes: Runs the pinned `@opennextjs/cloudflare`
adapter to produce `.open-next/` for the `agent-outbox` Worker. This command
builds deployment artifacts locally but does not upload, deploy, or mutate
Cloudflare state.

- Dry-run the Worker deployment package

```bash
pnpm run worker:dry-run
```

Run from: repo root Prerequisites: pinned `pnpm` dependencies are installed.
Notes: Builds a fresh OpenNext bundle, then runs pinned Wrangler with
`--dry-run --env-file /dev/null` against `wrangler.jsonc`. It verifies the
Worker bundle, custom domain route config, disabled workers.dev route, cron
config, observability config, and static assets without uploading or mutating
Cloudflare state.

- Deploy the Worker to Cloudflare

```bash
pnpm run worker:deploy
```

Run from: repo root Prerequisites: Explicit owner approval for production
Cloudflare writes; production runtime configuration loaded from approved
operator-controlled secrets; pinned dependencies installed; Cloudflare deploy
token or Wrangler OAuth is authenticated for the intended account; and
`CLOUDFLARE_HYPERDRIVE_ID` is loaded from the production Hyperdrive config.
Notes: External write. Calls the project-owned deploy wrapper, which builds a
fresh OpenNext bundle with only non-secret runtime configuration, writes true
runtime secrets to a temporary dotenv file outside the repo, writes a temporary
Wrangler config with the Hyperdrive binding outside the repo, removes both
temporary files after deploy, and runs pinned Wrangler with `--env-file
/dev/null`, `--secrets-file`, deploy-time `--var NAME:value` bindings for
public/runtime configuration, and no `--keep-vars`. Runtime secret values are
not exposed to the build subprocess. The deploy targets the Worker named
`agent-outbox` with `app.agent-outbox.dev` as the custom domain, workers.dev
disabled, Hyperdrive bound as `AGENT_OUTBOX_DATABASE`, and cron `17 * * * *`.
Do not use from credential-free CI or before production runtime values have been
loaded through approved operator-controlled stores. `DATABASE_APP_ROLE_URL` is
intentionally not uploaded as a Worker secret; production database access uses
the Hyperdrive binding.

## Maintenance

- Validate Flyway migration history

```bash
make migration-validate
```

Run from: repo root Prerequisites: `make setup` has completed and Docker is
running. `DATABASE_MIGRATION_URL` must point at the target Postgres database.
Notes: Runs pinned Flyway `12.10.0` in Docker against `db/migrations/` and
validates the schema history/checksums without applying new migrations. When
the target database listens on the host, either set `FLYWAY_DOCKER_NETWORK=host`
where Docker supports host networking or use a Docker-reachable host such as
`host.docker.internal` in `DATABASE_MIGRATION_URL`. Online index migrations
must use a companion `.sql.conf` file with `executeInTransaction=false`; the
wrapper validates that pattern and passes Flyway's PostgreSQL session-lock
setting when needed.

- Apply pending Flyway migrations

```bash
make migration-migrate
```

Run from: repo root Prerequisites: `make setup` has completed and Docker is
running. `DATABASE_MIGRATION_URL` must point at the target Postgres database.
Notes: Applies pending host-agnostic Flyway migrations from `db/migrations/`.
Do not use provider dashboards or provider-specific migration commands for
schema changes. When the target database listens on the host, either set
`FLYWAY_DOCKER_NETWORK=host` where Docker supports host networking or use a
Docker-reachable host such as `host.docker.internal` in
`DATABASE_MIGRATION_URL`. Online index migrations must use the documented
Flyway script config pattern so they run outside a transaction.

- Replay Flyway migrations from scratch

```bash
make migration-replay
```

Run from: repo root Prerequisites: `make setup` has completed, Docker is
running, and `DATABASE_MIGRATION_URL` points at an empty disposable Postgres
database. Notes: Runs Flyway pre-migrate validate with pending migrations
ignored, then migrate, then strict validate again. CI runs this against a raw
`postgres:17` service; do not point it at shared or durable data. When the
target database listens on the host, either set
`FLYWAY_DOCKER_NETWORK=host` where Docker supports host networking or use a
Docker-reachable host such as `host.docker.internal` in
`DATABASE_MIGRATION_URL`. This gate also replays online index migrations using
the repository Flyway script config pattern.

- Create a new Flyway migration file

```bash
touch db/migrations/VYYYYMMDDHHMMSS__lower_snake_description.sql
```

Run from: repo root Prerequisites: None. Notes: Use UTC timestamps and
lower-snake descriptive names. Flyway migration commands and CI migration
replay validate migration filenames; `make test` unit-tests the filename
parser.

- Verify database policies and cleanup against migrated Postgres

```bash
AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 DATABASE_MIGRATION_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci' corepack pnpm exec node --test --test-name-pattern 'phase 3 local database' tests/foundation.test.mjs
```

Run from: repo root Prerequisites: `make setup` has completed and Flyway
migrations have been applied to the target database. Notes: Runs the opt-in
database-backed test that proves restricted app-role posture, transaction-local
Row Level Security isolation, and shared cleanup deletion behavior. Normal
`make test` skips this test unless `AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1`.

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
AWS_PROFILE
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID
CLOUDFLARE_ZONE_NAME
CLOUDFLARE_NAMESERVERS
CLOUDFLARE_DNS_API_TOKEN
CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN
CLOUDFLARE_TOKEN_MANAGEMENT_API_TOKEN
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
STRIPE_ACCOUNT_ID
SENTRY_DSN
SENTRY_BROWSER_DSN
SENTRY_RELEASE
SENTRY_ORG
SENTRY_PROJECT
SENTRY_AUTH_TOKEN
AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD
AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH
NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN
CALLER_KEY_HASH_SECRET
SMOKE_OR_CLEANUP_TOKEN
AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE
AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE
AGENT_OUTBOX_HOSTED_HEALTH_QUOTA_EVIDENCE
AGENT_OUTBOX_HOSTED_HEALTH_FILE_EVIDENCE
AGENT_OUTBOX_HOSTED_HEALTH_AUDIT_EVIDENCE
AGENT_OUTBOX_HOSTED_HEALTH_ABUSE_COST_EVIDENCE
AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE
AGENT_OUTBOX_BILLING_SMOKE_COOKIE
```

Notes: Stripe billing variables (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PAID_MONTHLY_PRICE_ID`,
`STRIPE_PAID_YEARLY_PRICE_ID`, and `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`)
are present in `.env.example`. `NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN` is
a public production-only token. Production Sentry runtime capture requires
`SENTRY_RELEASE` to be injected by the deploy path using the immutable Worker
build identifier, such as the Git commit SHA or release tag. Sentry
release/source-map upload requires `SENTRY_ORG`, `SENTRY_PROJECT`,
`SENTRY_AUTH_TOKEN`, and both `AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD=1` and
`AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH=1`; ordinary production builds should
not set the deploy/release-path flag.
Credential-free gates do not require these values. Local/test-mode billing
verification does require the matching Stripe test-mode objects and webhook
signing secret. Hosted health and billing smoke env-file variables are
operator-only conveniences for production inspection and should not be installed
as Worker runtime values.

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
default. The same workflow also installs Playwright Chromium and runs a
separate `make browser` job, plus a separate `make migration-replay` job against
a raw `postgres:17` service followed by the opt-in database policy and human
bootstrap database tests.

- GitHub Actions release-check gate

```bash
make setup
make release-check
```

Run from: GitHub Actions checkout root Prerequisites: Workflow provisions Node
`24.18.0` and Go `1.26.4` before running commands. Notes:
`.github/workflows/release-check.yml` runs these commands with read-only
repository permissions. The workflow is verification-only and has no deployment
or package publication step. The same workflow also installs Playwright
Chromium and runs a separate `make browser` job, plus `make migration-replay`
against a raw `postgres:17` service followed by the opt-in database policy and
human bootstrap database tests.
