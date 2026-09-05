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
Corepack to cache pnpm `11.25.0`, then installs from the lockfile using
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

- Regenerate the public OpenAPI document and branded documentation bundle

```bash
corepack pnpm run docs:generate
```

Run from: repo root. Notes: Reads the executable public contract and curated
`docs/spec/public-api*.md` guides, then rewrites `docs/openapi.json` and the
checked-in browser bundle used by `/docs/api` routes.

- Check the public API contract and documentation for generated drift

```bash
corepack pnpm run docs:check
```

Run from: repo root. Notes: Fails when the executable contract or a curated
guide changes without regenerating both public artifacts. The normal build and
check workflows include this gate.

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

- Regenerate Go system-contract constants

```bash
node scripts/system-contract.mjs generate
```

Run from: repo root Prerequisites: Node `22.13.0` or newer. Notes: Regenerates
the committed Go view of `system-contract.json`; it does not invoke Go.

- Check system-contract drift

```bash
node scripts/system-contract.mjs check
```

Run from: repo root Prerequisites: Node `22.13.0` or newer. Notes: Validates
the contract schema, generated Go file, selected consumers, Wrangler cron,
public documentation, and the persisted device-poll default. This Node-only
check runs first in `make check` and does not require the Go toolchain.

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
deterministic/no-color output, credentials-file, HTTP-client, caller control-plane,
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
`release --snapshot --clean` package set. Renderer unit tests are covered by
`make go-check`; exact numbered-release cask rendering runs in
`make cli-release-dist` against `checksums.txt`, not snapshot names. This command
must not publish, tag, upload, deploy, or require private provider credentials.

- Build tagged CLI release artifacts without publishing

```bash
make cli-release-dist RELEASE_TAG=vX.Y.Z
```

Run from: repo root. Prerequisites: Go `1.26.4` must be available, the stable
tag must exist locally, and it must point at `HEAD`. Notes: Runs pinned
GoReleaser for the exact tag with publishing disabled, producing four platform
archives and `checksums.txt`, then renders
`dist/homebrew/Casks/agent-outbox.rb` through the project-owned Go renderer.
The production release workflow creates or verifies an ephemeral exact local
tag, runs this command plus Ruby and Homebrew style checks before deployment,
and passes the same certified files to post-deploy publication. This command
itself performs no remote mutation.

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
corepack pnpm run worker:build
```

Run from: repo root Prerequisites: `make setup` has completed or pinned `pnpm`
dependencies are installed. Notes: Runs the pinned `@opennextjs/cloudflare`
adapter to produce `.open-next/` for the `agent-outbox` Worker. This command
builds deployment artifacts locally but does not upload, deploy, or mutate
Cloudflare state.

- Dry-run the Worker deployment package

```bash
corepack pnpm run worker:dry-run
```

Run from: repo root Prerequisites: pinned `pnpm` dependencies are installed.
Notes: Builds a fresh OpenNext bundle, then runs pinned Wrangler with
`--dry-run --env-file /dev/null` against `wrangler.jsonc`. It verifies the
Worker bundle, custom domain route config, disabled workers.dev route, cron
config, observability config, and static assets without uploading or mutating
Cloudflare state.

- Apply Worker routes and cron triggers without an application release

```bash
corepack pnpm exec wrangler triggers deploy --name agent-outbox --dry-run --env-file /dev/null
corepack pnpm exec wrangler triggers deploy --name agent-outbox --env-file /dev/null
```

Run from: repo root. Prerequisites: an operator-controlled environment with the
production Worker deploy token mapped to `CLOUDFLARE_API_TOKEN`. Notes: This
experimental Wrangler command applies `wrangler.jsonc` routes/domains and cron
triggers. Application releases using `wrangler versions upload` do not apply
those settings; the numbered-release compare-triggers gate fails until this
operator procedure has been applied. Full procedure:
[release runbook](../ops/release.md#apply-worker-routes-and-cron-triggers).

- Check or reconcile the always-on client-events edge rate limit

```bash
pnpm run cloudflare:ratelimit --check
pnpm run cloudflare:ratelimit --apply
```

Run from: repo root. Prerequisites: AWS SSO profile `conn` is authenticated and
canonical SSM contains the production zone id and narrow WAF/Rulesets token.
Notes: `--check` is read-only and fails unless the rule is present and enabled.
`--apply` preserves unrelated `http_ratelimit` phase rules while reconciling the
canonical 120-request/10-second `/api/client-events` rule as enabled. The wrapper
loads secrets directly into the child process without caching or printing them.

- Validate a numbered release target

```bash
make release-preflight VERSION=<new-version>
```

Run from: repo root. Prerequisites: the operator supplied the exact stable
version and the `origin` remote is reachable. Notes: Fetches `main` and numbered
tags, reports the working-tree package version, the fetched `main` package
version, latest numbered tag, and target. It accepts equality with the package
and `main` version to resume an unpublished prepared release, and rejects an
existing tag, a target older than either package version, or a target not newer
than the latest tag. Run before capturing release screenshots.

- Capture landing-page screenshots for release review

```bash
make marketing
```

Run from: repo root. Prerequisites: Docker is running. Notes: Builds and runs
the pinned Linux/amd64 Playwright capture environment, regenerates the tracked
screenshots directly in `public/`, and writes a before/after/overlay/difference
report under `.agent-layer/tmp/marketing-capture/review/`. Review the unstaged
working-tree changes before approval or commit.

- Attest a human-approved screenshot set

```bash
make marketing-approve VERSION=<new-version>
```

Run from: repo root. Prerequisites: `make marketing` completed and the owner
explicitly approved every regenerated tracked screenshot. Notes: Updates
`marketing/screenshots.json` with the approved version and SHA-256 hashes after
repeating the fetched-tag release preflight; the PNGs remain in their final
`public/` locations. Run before the matching `package.json` version bump.

- Verify committed release screenshots

```bash
make marketing-check
make marketing-verify
```

Run from: repo root. Prerequisites: Docker is required only for
`marketing-verify`. Notes: `marketing-check` validates the package/manifest
version and committed hashes. `marketing-verify` performs a pinned fresh
capture into ignored scratch space and fails on pixel drift without modifying
committed assets.

- Dispatch a certified production release

```bash
gh workflow run deploy-production.yml --ref main
```

Run from: repo root Prerequisites: `gh` authenticated to the repository; the
candidate merged to `main`; `package.json` containing a new stable version other
than `0.0.0`; explicit owner approval; and the protected GitHub `production`
environment fully configured. Notes: External write. GitHub Actions reruns the
exact-SHA release gate, prepares an owned unpublished draft with byte-verified
CLI assets, captures the current rollback target, uploads an inactive Worker
version, applies forward-only migrations, smokes the candidate at 0% through a
production-hostname version override, promotes it, and publishes the GitHub
release by ID. Any proven pre-commit failure restores the previous Worker to
100% and deletes only that run's owned `prepared` draft. Failed post-publication
Homebrew distribution is retried independently. Worker upload and traffic
commands reject execution outside the designated GitHub Actions workflows.

- Reconcile an abandoned pre-commit production release

```bash
gh workflow run reconcile-production-release.yml --ref main \
  -f release_tag=v<version> \
  -f candidate_sha=<full-certified-sha>
```

Run from: repo root Prerequisites: `gh` authenticated to the repository;
explicit owner approval. Notes: External write. The protected workflow uses the
same reconciler as deploy-job cleanup. It derives identities from the owned
draft marker and Cloudflare, and from observed live prior traffic only when a
pre-persistence `prepared` draft meets the live-state invariants. It validates
any optional inputs against that state, then proves committed, retries a
`publishing` draft by ID only when certified CLI assets can be re-proved,
restores prior@100 and deletes only an owned `prepared` draft after proving
traffic, prior SHA, tag absence, and deletion, or holds without mutation.
Artifact-less reconcile cannot publish GitHub draft bytes; retry the original
deploy run with Re-run failed jobs. It never deletes published releases or
orphan tags.

- Dispatch a manual rollback to a previously tagged release

```bash
gh workflow run rollback-production.yml --ref main \
  -f release_tag=v<version> \
  -f worker_version_id=<cloudflare-version-id>
```

Run from: repo root Prerequisites: `gh` authenticated to the repository;
explicit owner approval; a previously verified numbered release tag; and its
Cloudflare Worker version id from read-only deployment inspection. Notes:
External write. The protected GitHub Actions workflow validates the tag and
version id, proves the Worker version carries that release tag, rolls back
through pinned Wrangler, and verifies that the exact tagged commit is serving.
Never run a local mutating Wrangler rollback.

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
This local command is only for local or disposable databases; production
migrations run exclusively through the protected formal release workflow. Do
not use provider dashboards or provider-specific migration commands for schema
changes. When the target database listens on the host, either set
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

- Run the local and CI database verification suite against migrated Postgres

```bash
AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 DATABASE_MIGRATION_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci' make test-database
```

Run from: repo root Prerequisites: `make setup` has completed and Flyway
migrations have been applied to a disposable target database. Notes: This is the
canonical command used after migration replay in CI and release-check. It
serially discovers every root `tests/*.test.mjs` file, so new database-gated
tests are included automatically.
`DATABASE_MIGRATION_URL` must use the established privileged migration owner
(superuser, or `BYPASSRLS` with SET-capable membership in `agent_outbox_app`),
never the restricted runtime `agent_outbox_app`.
It proves restricted app-role posture, transaction-local Row Level Security
isolation, human bootstrap and answer behavior, authenticated transaction
behavior, and failure-safe test cleanup. Serialization keeps shared-database
lifecycle checks deterministic. Normal `make test` skips
database-backed tests unless `AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1`.

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

- Review local environment variable names

```bash
sed -n '1,240p' .env.example
```

Run from: repo root Prerequisites: None. Notes: `.env.example` is the canonical
tracked variable list and documents which values are required, optional,
runtime-only, or operator-only. Diagnostics may print missing names but must not
print configured values.

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
a raw `postgres:17` service followed by the canonical serialized database
verification suite.

- GitHub Actions Policy gates

```bash
node scripts/policy-gates/megachange-eval.test.mjs
node scripts/policy-gates/migration-discipline-scan.mjs --fixtures scripts/policy-gates/migration-discipline-fixtures.txt
node scripts/policy-gates/legal-policy-gate.mjs --fixtures scripts/policy-gates/legal-policy-fixtures.txt
```

Run from: repo root Prerequisites: `make setup` has completed. Notes:
`.github/workflows/policy-gates.yml` runs these fixture checks, then evaluates
the PR diff for megachange, destructive migrations, and public legal-policy
changes. Human-only labels `megachange-approved`,
`migration-destructive-approved`, and `legal-policy-approved` are the only
overrides. `make test` also runs the fixture self-checks.

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
against a raw `postgres:17` service followed by the canonical serialized
database verification suite.
