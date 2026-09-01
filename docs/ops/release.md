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

The workflow applies one serialized, publicly atomic release sequence. Schema is
forward-only infrastructure state, applied before candidate traffic and never
rolled back automatically. Every candidate migration must be compatible with the
currently live release and the candidate. A proven pre-commit failure may leave
expand migrations, inactive Worker versions, Sentry records, Actions artifacts,
and provider audit records. It may not leave candidate traffic, a published
release, a tag, public release assets, a Homebrew change, or an owned draft. The
numbered version remains reusable. After publication is proven, a failed
anonymous-download or Homebrew distribution check leaves the committed release,
tag, public assets, and any tap pull request in place and must not roll back or
delete them.

1. Validate the dispatch is the exact current `main` SHA, resolve the stable
   version from `package.json`, and require public-repository plus Homebrew tap
   access.
2. Rerun the reusable release gate on that SHA: `make release-check`, browser
   tests, and migration replay/database policy checks.
3. Create or verify an ephemeral local `v<package.json version>` tag on the
   exact candidate, build the four macOS/Linux archives and `checksums.txt` with
   pinned GoReleaser, render `Casks/agent-outbox.rb` from those checksums
   through the project-owned Go renderer, require Ruby syntax and Homebrew style
   checks, and retain those exact files as the certified workflow artifact.
4. Reconcile every GitHub release sharing the proposed tag. Identify drafts by
   release ID, `target_commitish`, draft status, and an exact ownership marker
   (repository, run ID, candidate SHA, release tag, state `prepared` or
   `publishing`, and the prior SHA/version plus candidate Worker version as they
   become known). GitHub may represent a draft whose requested tag does not yet
   exist as an `untagged-*` tag; the exact ownership marker remains the source
   of truth until publication supplies the requested tag explicitly. Create or
   adopt exactly one owned draft, then upload and byte-verify every certified
   CLI archive and `checksums.txt` against that release ID before any production
   mutation. Duplicate, unowned, or conflicting same-tag state stops without
   mutation.
5. Capture the one current 100%-traffic Cloudflare Worker version and its live
   runtime release SHA, then run runtime smoke against that rollback target.
   Compare `wrangler.jsonc` `routes` and `triggers` at that live SHA with the
   candidate and fail if they differ; route or cron changes are a separate
   operator-controlled infrastructure operation, not part of an application
   release. See
   [Apply Worker routes and cron triggers](#apply-worker-routes-and-cron-triggers).
6. Build once, dry-run, and upload the Worker as an inactive version with
   `wrangler versions upload`. Stamp `--tag` with the public `vX.Y.Z` and
   `--message` with `run <id> release <releaseId> <sha12>`. Parse and keep the
   uploaded version ID. Do not run `wrangler deploy` or the experimental trigger
   deployment command. `wrangler versions list` returns only the 10 most recent
   versions and has no pagination flag; if a candidate falls outside that
   window, identity recovery holds instead of guessing.
7. Validate the durable production Flyway history, apply every pending
   checked-in migration using `DATABASE_MIGRATION_URL` from the protected
   `production` GitHub environment, and validate the resulting history.
8. Create a Cloudflare deployment with the prior version at 100% and the
   candidate at 0%. Smoke the candidate through the production hostname by
   sending `Cloudflare-Workers-Version-Overrides: agent-outbox="<uuid>"` on
   every smoke request, including public pages, negative authentication probes,
   and database/log/scheduled/Sentry canaries. Prove the runtime canary SHA is
   the candidate before other probes and again at the end. HTTP canaries cover
   scheduled-handler logic but do not prove cron routing; service-binding or
   subrequest traffic may not inherit the override unless Cloudflare forwards
   it.
9. Promote the exact candidate version to 100% as a single-version deployment,
   then smoke production without an override.
10. Reverify the owned draft by release ID. Resolve the remote tag immediately
    before publication; it must be absent or still dereference to the candidate.
    Update the owned draft marker from `prepared` to `publishing`, then publish
    by release ID. Entering `publishing` is the conservative point of no
    automatic rollback. Proven GitHub publication of that release ID plus the
    dereferenced tag is the transaction commit point.
11. Download every public release asset without authentication and require byte
    identity with the certified workflow artifact.
12. Use the Homebrew tap GitHub App to open or refresh
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
production mutation. An `if: always()` cleanup step runs the same reconciler as
manual reconciliation. After restoring or verifying the previous Worker as a
single 100% deployment, cleanup may delete only the exact-owned `prepared`
draft. It never deletes a `publishing` or published release, never deletes an
orphan tag, and never rolls back a committed publication. Restoration always
collapses to the prior version alone at 100%; prior@100/candidate@0 is not an
acceptable terminal state. If GitHub is unreadable after publish intent, the job
stays red in hold state. Database migrations are not reversed.

Once publication is proven, production and the public GitHub release are one
committed unit. Anonymous-download verification and Homebrew tap automation run
afterward as idempotent distribution checks; their failure never rolls back or
deletes a committed release.

Within the certified artifact's seven-day retention window, choose **Re-run
failed jobs** on the original workflow run. This reuses the exact artifact and
the same run ID so the owned draft can be adopted. Do not re-dispatch the
workflow or choose **Re-run all jobs** for this recovery: a fresh build embeds a
new build date and may not be byte-identical. After artifact expiry, stop and
prepare an explicit new-version release rather than rebuilding under an existing
tag.

### Reconcile an abandoned pre-commit release

Use `.github/workflows/reconcile-production-release.yml` for objective,
idempotent manual reconciliation. It shares `production-deploy` concurrency and
the protected `production` environment. Dispatch it from the current `main`:

```bash
gh workflow run reconcile-production-release.yml --ref main \
  -f release_tag=v<version> \
  -f candidate_sha=<full-certified-sha> \
  -f github_release_id=<optional-release-id> \
  -f prior_version_id=<optional-prior-worker-version-id>
```

The reconciler derives candidate SHA, original run ID, release ID, prior
SHA/version, and candidate Worker version from the owned draft marker and
Cloudflare version annotations. If the marker does not yet record a prior
identity, that identity may be derived from observed live state only when every
invariant holds: the draft is exact-owned and `prepared`, the tag is absent,
Cloudflare is readable with exactly one version at 100%, the runtime canary
returns a configured SHA that is not the candidate, and nothing indicates the
candidate is live. Optional workflow inputs are validated against that derived
state; they cannot replace missing identities. It then chooses only among: prove
committed; retry a `publishing` draft by ID when GitHub is readable and the
exact certified CLI asset inventory and bytes can be re-proved immediately
before `draft: false`; restore the previous Worker to 100%, prove that traffic
and the prior runtime SHA, re-read the exact-owned `prepared` draft, confirm the
tag is absent, delete it by ID, and prove it is gone; or hold without mutation.
Publication never sets `draft: false` without that certified-asset proof. Manual
reconciliation does not download the original workflow artifact; without those
exact files it holds rather than publishing GitHub draft bytes. Recover by
choosing **Re-run failed jobs** on the original deploy run so it reuses the
certified artifact. Ambiguous or unprovable ownership, candidate-live or
unreadable provider state, or a prior identity that cannot be proven, stops
loudly. A scheduled detector fails nonzero only for abandoned exact system-owned
markers whose owning GitHub Actions run is missing or terminal, including the
documented orphan when it still carries this system's marker. It reports
human-authored, unowned, or malformed drafts as warnings so unrelated drafts do
not keep the schedule red. It excludes queued and in-progress runs so an active
release is not treated as abandoned. It must not join `production-deploy`
concurrency or mutate, because GitHub concurrency keeps only one pending run and
can cancel a queued human release.

The Worker upload and traffic commands fail outside the sanctioned GitHub
Actions workflows. Do not load production credentials locally to bypass them and
do not run mutating Wrangler deploy commands from an operator shell.

### Apply Worker routes and cron triggers

`wrangler versions upload` does not apply `wrangler.jsonc` `routes` or
`triggers`. An application release therefore compares those fields at the live
SHA with the candidate and stops if they differ. Changing custom domains or the
cron schedule is a separate operator-controlled infrastructure operation.

From an operator-controlled environment that maps the production Worker deploy
token into `CLOUDFLARE_API_TOKEN` (never a generic token in repo-local `.env`):

```bash
corepack pnpm exec wrangler triggers deploy \
  --name agent-outbox \
  --dry-run \
  --env-file /dev/null

corepack pnpm exec wrangler triggers deploy \
  --name agent-outbox \
  --env-file /dev/null
```

This Wrangler command is experimental and applies routes/domains and cron
triggers without `wrangler deploy` and without changing Worker traffic. Do not
run it as part of a numbered application release. After it succeeds, dispatch
`deploy-production.yml` so the application release can pass the compare-triggers
gate.

### Existing orphan draft and immutable releases

GitHub currently has an extra draft for `v0.2.7` with release ID `378670392`
created during the failed finalizer of run `33196586800`. Do not delete it as
part of ordinary implementation or tests. If that draft still carries this
system's exact ownership marker, the scheduled detector stays red until an
operator deletes it; if it is unowned or malformed relative to the current
marker, the detector reports it as a warning only. After verifying it is still a
draft for `v0.2.7` with no assets and the intended candidate target, an operator
may delete that exact ID:

```bash
gh api repos/conn-castle/agent-outbox/releases/378670392
gh api --method DELETE repos/conn-castle/agent-outbox/releases/378670392
```

Do not delete by tag name. After the new flow is validated in production, an
operator should enable GitHub immutable releases in repository settings. Do not
change that setting from an agent session.

Production Flyway migration application follows the same boundary: it runs only
inside `deploy-production.yml`, after the inactive Worker version is uploaded
and before candidate traffic. Never populate a local shell from production SSM
and invoke `migration:migrate` against the durable database.

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

The README, public API quickstart, and landing page must advertise this exact
verified Homebrew command. Production preparation creates the numbered GitHub
release as an owned draft and uploads and reconciles every release archive and
`checksums.txt` by release ID before production mutation. The workflow publishes
that draft by ID only after override smoke and 100% promotion prove the
candidate SHA. Keep the product-access statement accurate: both CLI installation
paths and browser-approved caller connection are public.

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

The release workflow automatically restores only Worker traffic when a failure
occurs before GitHub publication is proven; it never reverts Flyway schema
history and never deletes a `publishing` or published release. Every production
migration must therefore remain compatible with both the outgoing and incoming
Worker through expand/contract sequencing. After publication, production and the
numbered release remain together. For a problem found after a workflow
completed, inspect recent deployments read-only to identify the Cloudflare
version id for a previously tagged release:

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
