# Release

Use this runbook for final hosted release readiness and branch-protection
changes. Keep exact provider ids, secret values, account ids, and private host
values in approved operator-controlled stores, not in this file.

## Pre-Release Gate

Commit a new stable `package.json` version such as `0.1.0` in the release pull
request. Version `0.0.0`, prerelease versions, reused tags, uncommitted
versions, and non-`main` refs fail before deployment. The committed package
version is the single source for the numbered `v<version>` tag and GitHub
Release.

Before the first public CLI release, complete these one-time Homebrew
preconditions:

- finish the repository-history review and make `conn-castle/agent-outbox`
  public so unauthenticated Homebrew clients can download GitHub release assets;
- mirror `HOMEBREW_TAP_APP_ID` and `HOMEBREW_TAP_PRIVATE_KEY` from the canonical
  `conn` / `us-east-1` SSM parameters `/conn-castle/homebrew-tap/github-app-id`
  and `/conn-castle/homebrew-tap/github-app-private-key` into repository-level
  GitHub Actions secrets (the publication job has no production environment);
  never create an independent GitHub-only value;
- add `agent-outbox` to the tap repository's guarded binary-cask auto-merge
  allowlist.

The release workflow checks every uploaded asset without authentication before
it requests a tap change. A private repository therefore fails explicitly after
the verified app release is finalized and cannot publish an unusable Homebrew
cask.

After the operator chooses the exact next stable version, validate it before
capturing screenshots:

```bash
make release-preflight VERSION=<new-version>
```

The preflight fetches `main` and numbered tags, prints the working-tree package
version, the fetched `main` package version, the latest tag, and the requested
target. The target may equal the package and fetched `main` version so an
unpublished prepared release can be resumed. It rejects a target older than
either package version, not newer than the latest tag, or whose tag already
exists. Comparing against the fetched `main` revision rather than only the
working tree keeps a stale branch from preparing an older version.

Before changing `package.json`, capture the landing-page product screenshots:

```bash
make marketing
```

The command renders every asset in `marketing/screenshots.json` from the
deterministic human-review fixture inside the pinned Linux/amd64 Playwright
container. The fixture renders against a frozen reference time rather than the
wall clock, so identical code produces identical pixels on any capture date. It
writes candidates under `.agent-layer/tmp/marketing-capture/review/` and
compares decoded pixels against the committed baseline. Differences at or below
the capture tolerance (a maximum channel delta of 5 and at most 0.1% of pixels)
are discarded, so they do not create a noisy working-tree diff. Only substantive
differences are copied into `public/` and require human review. After that
review, attest the exact working-tree set and then make the matching
package-version change:

```bash
make marketing-approve VERSION=<new-version>
```

The approval command repeats the fetched-tag preflight and updates only the
manifest's hashes and release version; the regenerated PNGs are already in their
tracked final locations awaiting the release-prep commit. It must run during
release preparation, never from the production release workflow.
`make marketing-check` verifies the package version, manifest attestation, asset
inventory, and hashes without launching a browser. `make marketing-verify`
recaptures into scratch space and fails only when a substantive difference is
found, without modifying committed files. Production preparation repeats the
fast attestation check and fails before certification or deployment if stale.

Run these local gates from the repo root before a production deploy or branch
protection change:

```bash
make check
make browser
make go-check
make package-check
make marketing-check
make marketing-verify
make release-check
corepack pnpm run worker:dry-run
```

When Docker and a disposable Postgres database are available, also run:

```bash
make migration-replay
AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 DATABASE_MIGRATION_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci' make test-database
```

For hosted production, use operator-controlled env files:

```bash
AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE=<production-smoke-env> make smoke-runtime
AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE=<production-health-env> make hosted-health
AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE=<production-billing-env> make billing-smoke
```

`make hosted-health` and `make billing-smoke` return exit code `2` when no check
failed but safe operator evidence or owner action is still required. Treat that
as a release blocker unless the owner explicitly accepts the missing evidence
for the release window.

## CI Gates

The current pull-request CI gate names are:

- `make check`
- `make go-check`
- `make browser`
- `make migration-replay`
- `Policy gates`

The release-check workflow also exposes:

- `make release-check`
- `make browser`
- `make migration-replay`

Do not require a status check in branch protection until a fresh or recent
workflow run confirms the exact check name is green for the current tree.
`release-check.yml` also runs on pull requests by design. Its browser and
migration jobs intentionally overlap ordinary CI: this repository prioritizes
independent automated certification and early release-specific feedback over
minimizing runner consumption.

`.github/workflows/policy-gates.yml` is a separate required PR workflow, not a
second merge phase. It fails when a pull request exceeds the megachange cap
(more than 30 non-allowlisted files or 1000 non-allowlisted lines), contains
destructive Flyway SQL, or changes the published Privacy Policy, Terms of
Service, or shared legal identity, unless a human applies the matching
human-only label through the GitHub web interface: `megachange-approved`,
`migration-destructive-approved`, or `legal-policy-approved`. Agents must never
apply those labels. Applying a label retriggers only Policy gates.

## Production Deploy

Production release is manual-only through
`.github/workflows/deploy-production.yml` and the protected `production` GitHub
environment. Dispatch it from `main` only:

```bash
gh workflow run deploy-production.yml --ref main
```

The workflow applies one serialized release sequence:

1. Validate the dispatch is the exact current `main` SHA and resolve the new
   stable version from `package.json`.
2. Rerun the reusable release gate on that SHA: `make release-check`, browser
   tests, and migration replay/database policy checks.
3. Create or verify an ephemeral local `v<package.json version>` tag on the
   exact candidate, build the four macOS/Linux archives and `checksums.txt` with
   pinned GoReleaser, render `Casks/agent-outbox.rb` from those checksums
   through the project-owned Go renderer, require Ruby syntax and Homebrew style
   checks, and retain those exact files as the certified workflow artifact.
4. Prepare an unpublished GitHub Release draft whose `targetCommitish` is the
   exact candidate SHA, upload every certified CLI archive and `checksums.txt`,
   download them again, and require byte identity. A draft is validated by its
   target commit; GitHub may not create the numbered Git tag until publication.
   Require the repository to be public before any production mutation.
5. Capture the one current 100%-traffic Cloudflare Worker version and its live
   runtime release SHA, then run runtime smoke against that rollback target.
6. Validate the durable production Flyway history, apply every pending
   checked-in migration using `DATABASE_MIGRATION_URL` from the protected
   `production` GitHub environment, and validate the resulting history. A
   missing credential or failed migration stops the release before Worker
   deployment.
7. Build once with production public configuration, dry-run the generated
   artifact with its Hyperdrive and secret inventory, stamp the Worker version
   with `v<package.json version>`, and deploy that artifact.
8. Retry runtime smoke until the exact candidate SHA is serving successfully.
9. Only after live verification, publish the prepared draft as Latest. This is
   the release transaction's commit point. Publication is idempotent: it
   reconciles lost responses and proves both the published release and the
   resulting numbered tag resolve to the certified SHA before reporting success.
10. Download every public release asset without authentication and require byte
    identity with the pre-deploy certified workflow artifact.
11. Use the Homebrew tap GitHub App to open or refresh
    `bump-agent-outbox-vX.Y.Z` with the certified project-rendered
    `Casks/agent-outbox.rb`. The tap's own checks and guarded automation own the
    merge; do not merge the tap pull request manually.

The pipeline deploys only when current production is a single Worker version at
100% traffic that passes runtime smoke (step 5). During a broad production
outage, or a split/gradual rollout, it refuses to deploy; recover with the
manual rollback workflow below rather than this deploy workflow.

CLI packaging, cask rendering, Ruby syntax, and Homebrew style failures stop the
workflow before the protected production job begins. Draft creation, asset
upload/reconciliation, and repository-visibility failures also stop before any
production mutation. If any step fails after the deploy attempt starts but
before publication is proven, the same protected job restores the captured
Worker version, verifies the captured release SHA, leaves the unpublished draft
available for an idempotent retry, and remains red. Database migrations are not
reversed; every migration must remain compatible with both Worker versions. If
GitHub may have accepted publication but remains unreadable through every
reconciliation retry, the workflow stays red and refuses automatic rollback:
rolling back an already-public release would create the opposite inconsistency.
Rerun the failed job when GitHub is readable so exact tag/release proof decides
the state before another mutation.

Once publication is proven, production and the public GitHub release are one
committed unit and the workflow never rolls one back without the other.
Anonymous-download verification and Homebrew tap automation run afterward as
idempotent distribution checks; their failure leaves the committed release live
and requires only that failed downstream job to be retried.

Within the certified artifact's seven-day retention window, choose **Re-run
failed jobs** on the original workflow run. This reuses the exact artifact,
reconciles the existing draft/assets or refreshes the tap pull request, and
never replaces a conflicting asset. Do not re-dispatch the workflow or choose
**Re-run all jobs** for this recovery: a fresh build embeds a new build date and
may not be byte-identical. After artifact expiry, stop and prepare an explicit
new-version release repair rather than rebuilding under an existing tag. A
failed rollback stays visible in the workflow step outcomes and requires the
manual rollback procedure below.

### Repair an already-deployed unpublished release

Use `.github/workflows/repair-production-release.yml` only when an original
production workflow deployed and smoke-verified its exact candidate but failed
before publishing the release. The original run must be completed and failed,
all certification/build/deploy jobs must have succeeded, its finalizer must have
failed, and its exact certified artifact must still be unexpired. Dispatch the
repair from the current `main`:

```bash
gh workflow run repair-production-release.yml --ref main \
  -f source_run_id=<failed-production-run-id> \
  -f release_tag=v<version> \
  -f candidate_sha=<full-certified-sha>
```

The protected workflow validates those source facts, downloads rather than
rebuilds the original artifact, verifies its fixed inventory and checksums, and
proves production is still serving the exact candidate before changing release
state. It then reconciles the unpublished draft, uploads assets without
overwriting conflicts, proves byte identity, smoke-tests production again, and
publishes the release as the commit point. Public asset verification and the
Homebrew tap pull request follow publication. The repair does not deploy a
Worker, run migrations, build replacement binaries, or create/move a Git tag
directly. If the artifact has expired or production no longer serves the exact
candidate, stop and release a new version through the normal workflow.

The project-owned `worker:deploy` command is an internal workflow step and fails
outside `deploy-production.yml` on GitHub Actions. Do not load production
credentials locally to bypass it and do not run mutating Wrangler deploy
commands from an operator shell.

Production Flyway migration application follows the same boundary: it runs only
inside `deploy-production.yml`, after rollback-target verification and before
Worker deployment. Never populate a local shell from production SSM and invoke
`migration:migrate` against the durable database.

After the workflow publishes the numbered release, inspect the run and rerun
hosted runtime smoke and hosted health before broader rollout or accepting
provider-only evidence:

```bash
AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE=<production-smoke-env> make smoke-runtime
AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE=<production-health-env> make hosted-health
```

## Homebrew CLI Publication

GoReleaser owns only the release archives and checksums. The project-owned
`cli/internal/tools/rendercask` tool is the single cask template and derives all
four platform checksums from that exact release set. The production workflow
requires Ruby syntax and Homebrew style checks before deployment, then copies
the certified cask into `conn-castle/homebrew-tap` through a bot-authored pull
request. After the tap workflow merges it, verify from an unauthenticated
machine:

```bash
brew install --cask conn-castle/tap/agent-outbox
agent-outbox version
```

The README and public API quickstart must advertise this exact verified Homebrew
command. The landing page advertises the direct installer command
`curl -fsSL https://agent-outbox.dev/install.sh | sh`. Production preparation
creates the numbered GitHub release as a draft and uploads and reconciles every
release archive and `checksums.txt` before deployment. The workflow makes that
draft Latest only after exact-SHA production smoke passes. Keep the separate
product-access statement accurate: both CLI installation paths are public, while
caller connection remains invite-only during the hosted prerelease.

## Manual CLI Connect Smoke

Use isolated local config files and unique caller names when verifying the two
human-approval transports against production. These checks create caller,
credential, and audit records in the selected production account; they are
provider-wiring smoke checks, not substitutes for the hermetic CLI and browser
test suites.

Verify the loopback browser callback:

```bash
make go-build
mkdir -p .agent-layer/tmp
browser_caller="production-browser-smoke-$(date -u +%Y%m%d%H%M%S)"
browser_config=".agent-layer/tmp/${browser_caller}.json"
dist/agent-outbox --base-url https://app.agent-outbox.dev \
  --config "$browser_config" caller connect "$browser_caller"
dist/agent-outbox --base-url https://app.agent-outbox.dev \
  --config "$browser_config" --caller "$browser_caller" caller status
dist/agent-outbox --base-url https://app.agent-outbox.dev \
  --config "$browser_config" --caller "$browser_caller" \
  caller disconnect --revoke
```

The connect and revoke commands open the production approval page. Approve each
operation while signed in to the intended smoke account. Connect must return
through the loopback callback, store and activate the display-once credential,
and make `caller status` succeed before revocation.

Verify the terminal device-code fallback with a different unique caller name:

```bash
device_caller="production-device-smoke-$(date -u +%Y%m%d%H%M%S)"
device_config=".agent-layer/tmp/${device_caller}.json"
dist/agent-outbox --base-url https://app.agent-outbox.dev \
  --config "$device_config" caller connect "$device_caller" --device-code
dist/agent-outbox --base-url https://app.agent-outbox.dev \
  --config "$device_config" --caller "$device_caller" caller status
dist/agent-outbox --base-url https://app.agent-outbox.dev \
  --config "$device_config" --caller "$device_caller" \
  caller disconnect --revoke --device-code
```

Open the printed production verification URL and enter or confirm its user code
while signed in to the intended smoke account. The CLI must poll through
approval, store and activate the credential, pass `caller status`, and complete
the device-code revocation. Never record the display-once API key in smoke
evidence.

## Billing Smoke

`make billing-smoke` is no-charge by default. It is a production/provider wiring
check, not a feature-correctness test: hermetic unit, integration, and browser
tests own billing behavior, while hosted smoke verifies that the deployed app
can reach Clerk-authenticated billing routes and Stripe-hosted session creation
with live provider configuration.

With a valid Clerk session cookie in the billing smoke env file, the command can
create hosted Checkout sessions without completing payment. Billing Portal smoke
also requires the smoke account to have an existing Stripe customer id; if the
production fixture has no customer and the available Stripe operator credentials
cannot create one, treat `active_stripe_customer_required` as explicit
`action_required`, not as feature-test failure.

Full live billing completion requires owner approval for:

- smoke account;
- non-charging mechanism or real charge/refund path;
- expected Stripe customer/subscription/account state afterward;
- cancellation, refund, downgrade, or accepted-persistence steps;
- secret-free evidence to retain.

## Branch Protection

Enable or change `main` branch protection only after:

- local gates and CI gate names are settled;
- hosted smoke, hosted health, and billing smoke are complete or accepted;
- any provider write set is complete and reverified;
- the exact rule is approved by the owner.

Current policy:

- require a pull request before merging;
- require branches to be up to date before merge;
- require status checks `make check`, `make go-check`, `make browser`,
  `make migration-replay`, `make release-check`, and `Policy gates`;
- require conversation resolution;
- block force pushes and branch deletion;
- leave admin enforcement disabled so the owner can override when necessary;
- keep deploy-production manual and protected by the `production` environment,
  which only allows protected branches to deploy.

After enabling, verify the rule with read-only `gh` inspection and record only
the public policy shape in docs.

## Public Legal Gate

Pull requests that change `app/privacy-policy/page.tsx`,
`app/terms-of-service/page.tsx`, or `src/components/legal/LegalDocument.tsx`
fail Policy gates until a human applies `legal-policy-approved` in GitHub.

For every public release, verify:

- `/privacy-policy`, `/terms-of-service`, and `/contact` are publicly reachable;
- the global footer links the public policies, contact path, and PolyForm
  software license;
- sign-up/sign-in and hosted billing surfaces link the Terms and Privacy Policy;
- `/contact` successfully sends support, privacy, security, abuse, copyright,
  and legal messages through the restricted Cloudflare Email Service binding to
  `contact@agent-outbox.dev` in Zoho Mail;
- the public Privacy Policy matches
  [privacy-data-inventory.md](privacy-data-inventory.md), including current
  processors and retention behavior;
- the owner has reviewed the legal identity, U.S.-only market posture,
  subscription/cancellation/refund language, support boundaries, arbitration,
  class waiver, liability cap, and software-license carveout.

## Rollback

For a bad deploy, roll back Cloudflare Worker code/config first when migrations
remain compatible. If the issue is a secret or provider configuration change,
rotate or restore at the source service, update Systems Manager Parameter Store
and the matching GitHub `production` environment secret or variable, then
redeploy through the approved workflow. Do not use raw SQL or dashboard schema
edits for rollback.

The release workflow automatically rolls back only Worker code and configuration
when a failure occurs after deployment begins but before GitHub publication is
proven; it never reverts Flyway schema history. Every production migration must
therefore remain compatible with both the outgoing and incoming Worker through
expand/contract sequencing. After publication, production and the numbered
release remain together. For a problem found after a workflow completed, inspect
recent deployments read-only to identify the Cloudflare version id for a
previously tagged release:

```bash
corepack pnpm exec wrangler deployments list --name agent-outbox --env-file /dev/null
corepack pnpm exec wrangler deployments status --name agent-outbox --env-file /dev/null
```

Dispatch the protected rollback workflow; this is the only approved manual
rollback mutation:

```bash
gh workflow run rollback-production.yml --ref main \
  -f release_tag=v<version> \
  -f worker_version_id=<cloudflare-version-id>
```

The workflow resolves the expected commit from the existing numbered tag, proves
the selected Cloudflare version carries that same release tag, rolls back
through pinned Wrangler in the protected `production` environment, and accepts
the rollback only after runtime smoke confirms that exact SHA is serving. Never
run `wrangler rollback` locally.

After rollback, run hosted runtime smoke and hosted health for additional
provider evidence:

```bash
AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE=<production-smoke-env> make smoke-runtime
AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE=<production-health-env> make hosted-health
```

To redeploy after fixing configuration or code, commit a new stable package
version through a pull request and dispatch a new numbered production release.

## Owner Acceptance

Before a broader launch, the owner must accept:

- unresolved hosted-health or billing-smoke `action_required` items;
- any missing Cloudflare Web Analytics token caused by provider permission
  limits;
- Sentry release/source-map posture if source maps are not uploaded;
- final branch-protection and production-environment rules;
- the public legal gate and the exact legal/business commitments listed above.
