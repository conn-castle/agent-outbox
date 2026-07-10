# Release

Use this runbook for final hosted release readiness and branch-protection
changes. Keep exact provider ids, secret values, account ids, and private host
values in approved operator-controlled stores, not in this file.

## Pre-Release Gate

Run these local gates from the repo root before a production deploy or branch
protection change:

```bash
make check
make browser
make go-check
make package-check
make release-check
pnpm run worker:dry-run
```

When Docker and a disposable Postgres database are available, also run:

```bash
make migration-replay
AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 DATABASE_MIGRATION_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci' corepack pnpm exec node --test --test-name-pattern 'phase 3 local database' tests/foundation.test.mjs
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

The release-check workflow also exposes:

- `make release-check`
- `make browser`
- `make migration-replay`

Do not require a status check in branch protection until a fresh or recent
workflow run confirms the exact check name is green for the current tree.
`release-check.yml` currently also runs on pull requests; if duplicate browser
or migration jobs become too expensive, change workflow triggers only after
owner approval.

## Production Deploy

Production deploy is manual-only through
`.github/workflows/deploy-production.yml` and the `production` GitHub
environment. The deploy job is guarded to `refs/heads/main` and uses the
`production-deploy` concurrency group. The workflow runs
`pnpm run worker:dry-run`, then `pnpm run worker:deploy`.

After any Worker redeploy, rerun hosted runtime smoke and hosted health before
enabling branch protection or accepting the deploy:

```bash
AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE=<production-smoke-env> make smoke-runtime
AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE=<production-health-env> make hosted-health
```

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
  `make migration-replay`, and `make release-check`;
- require conversation resolution;
- block force pushes and branch deletion;
- leave admin enforcement disabled so the owner can override when necessary;
- keep deploy-production manual and protected by the `production` environment,
  which only allows protected branches to deploy.

After enabling, verify the rule with read-only `gh` inspection and record only
the public policy shape in docs.

## Public Legal Gate

Before public signup opens, verify:

- `/privacy-policy`, `/terms-of-service`, and `/contact` are publicly reachable;
- the global footer links the public policies, contact path, and PolyForm
  software license;
- sign-up/sign-in and hosted billing surfaces link the Terms and Privacy Policy;
- `contact@agent-outbox.dev` receives support, privacy, security, abuse,
  copyright, and legal mail through Zoho Mail;
- the public Privacy Policy matches
  [privacy-data-inventory.md](privacy-data-inventory.md), including current
  processors and retention behavior;
- the owner has reviewed the legal identity, U.S.-only market posture,
  subscription/cancellation/refund language, support boundaries, arbitration,
  class waiver, liability cap, and software-license carveout.

## Rollback

For a bad deploy, roll back Cloudflare Worker code/config first when migrations
remain compatible. If the issue is a secret or provider configuration change,
rotate or restore at the source service, update Systems Manager Parameter Store,
then redeploy through the approved wrapper. Do not use raw SQL or dashboard
schema edits for rollback.

Inspect recent Worker deployments:

```bash
pnpm exec wrangler deployments list --name agent-outbox --env-file /dev/null
pnpm exec wrangler deployments status --name agent-outbox --env-file /dev/null
```

Roll back to a known-good Worker version:

```bash
pnpm exec wrangler rollback <version-id> --name agent-outbox --message "Rollback <reason>" --yes --env-file /dev/null
```

After rollback, rerun hosted runtime smoke and hosted health:

```bash
AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE=<production-smoke-env> make smoke-runtime
AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE=<production-health-env> make hosted-health
```

To redeploy the current protected `main` workflow after fixing configuration:

```bash
gh workflow run deploy-production.yml --ref main
```

## Owner Acceptance

Before public signup or a broader launch, the owner must accept:

- unresolved hosted-health or billing-smoke `action_required` items;
- any missing Cloudflare Web Analytics token caused by provider permission
  limits;
- Sentry release/source-map posture if source maps are not uploaded;
- final branch-protection and production-environment rules;
- the public legal gate and the exact legal/business commitments listed above.
