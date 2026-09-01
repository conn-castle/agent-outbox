# Secrets

## Policy

AWS Systems Manager Parameter Store is the canonical project source of truth for
all managed, recoverable secrets and environment-owned provider configuration.
Service-native and GitHub stores are downstream runtime or deployment copies;
they are not an alternative authority.

Do not make GitHub Actions fetch from Systems Manager Parameter Store during
normal deploys. Continuous integration and deployment use GitHub secrets. The
deploy path does not read AWS at runtime because GitHub and Cloudflare need
locally available copies, but every copied value must match SSM.

Every secret provision or rotation must update, in this order:

- the source provider when the provider issues the credential;
- the matching Systems Manager Parameter Store parameter, making the new value
  canonical for Agent Outbox; and
- each service runtime or continuous deployment store that consumes a copy.

A service-only or GitHub-only secret has no recovery path and is treated as
incomplete setup.

## Parameter Layout

Naming convention:

```text
/agent-outbox/shared/<kebab-name>
/agent-outbox/environments/production/<kebab-name>
```

Development secrets may be stored in Systems Manager Parameter Store only when
they are not disposable.

Use local AWS SSO profile `conn`; its configured region and account select the
Agent Outbox Parameter Store. The stable parameter prefixes are
`/agent-outbox/environments/<stage>/` and `/agent-outbox/shared/`. Do not record
the AWS account id, region, KMS key id, or parameter values in tracked docs.

## Ownership Matrix

| Secret class                                                | Runtime/deploy consumer                                       | Canonical project source            | Notes                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Worker runtime secrets                           | Cloudflare Workers                                            | Systems Manager Parameter Store     | Install only the Worker runtime inventory below; [../../.env.example](../../.env.example) also includes local, operator, deploy, and migration variables. |
| Deploy credentials                                          | GitHub Actions secrets                                        | Systems Manager Parameter Store     | Use least-scoped Cloudflare tokens for configured resources.                                                                                              |
| Supabase database URLs and role passwords                   | Supabase plus Cloudflare runtime/Flyway migration environment | Systems Manager Parameter Store     | Use [migrations.md](migrations.md) for schema changes.                                                                                                    |
| Clerk secret keys                                           | Clerk plus Cloudflare runtime                                 | Systems Manager Parameter Store     | Publishable keys may be GitHub/Cloudflare environment config, mirrored if needed for recovery.                                                            |
| Stripe secret key, webhook secret, price ids, portal config | Stripe plus Cloudflare runtime                                | Systems Manager Parameter Store     | Test and live values are separate. Production uses live mode.                                                                                             |
| Sentry data source names, project metadata, and auth token  | Sentry plus Cloudflare/GitHub as needed                       | Systems Manager Parameter Store     | Runtime uses data source names only. Auth token is for source maps/operator tooling.                                                                      |
| Caller key hash secret (`CALLER_KEY_HASH_SECRET`)           | Cloudflare Worker runtime                                     | Systems Manager Parameter Store     | Required to hash display-once caller API keys. Losing or changing it requires caller credential rotation or rehashing.                                    |
| Caller API keys                                             | Agent Outbox database hash plus local caller secure store     | Not Systems Manager Parameter Store | Plaintext caller keys are display-once and never recovered. Rotate instead.                                                                               |

The CLI publication job does not use the protected production environment. Store
`HOMEBREW_TAP_APP_ID` and `HOMEBREW_TAP_PRIVATE_KEY` as repository-level GitHub
Actions secrets, mirrored from their canonical shared SSM parameters.

## Environment Variables

[../../.env.example](../../.env.example) is the tracked template and canonical
variable list for local `.env` files. Keep the implementation environment schema
and `.env.example` in sync. Do not duplicate the full variable inventory in this
runbook.

## Cloudflare Worker Runtime Inventory

Install only these app runtime values into the production Cloudflare Worker.
Recover secret values from Systems Manager Parameter Store or rotate them at the
source provider; do not infer production values from local development `.env`
files.

Runtime configuration values:

```text
APP_ENV
APP_BASE_URL
PUBLIC_APP_BASE_URL
CLERK_PUBLISHABLE_KEY
SENTRY_BROWSER_DSN
SENTRY_RELEASE
NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN
STRIPE_PAID_MONTHLY_PRICE_ID
STRIPE_PAID_YEARLY_PRICE_ID
STRIPE_BILLING_PORTAL_CONFIGURATION_ID
```

The production deploy wrapper passes these as deploy-time Wrangler
`--var NAME:value` bindings. `NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN` is
optional until the Web Analytics provider permission blocker is resolved; when
it is absent, the Worker deploy continues without that binding. The wrapper also
derives `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from `CLERK_PUBLISHABLE_KEY` for
Clerk's Next.js middleware/runtime package; do not store or rotate it as a
separate source value. The build subprocess receives these non-secret
configuration values plus the minimal process environment needed to run the
toolchain. When Sentry source-map upload is enabled
(`AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD` and
`AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH` set), the wrapper additionally threads
`SENTRY_ORG`, `SENTRY_PROJECT`, and the `SENTRY_AUTH_TOKEN` secret into the
build subprocess only — never into the Worker runtime `--var` bindings and never
into the wrangler deploy subprocess — so the Sentry build plugin can create the
release and upload source maps.

Deploy-only configuration values:

```text
CLOUDFLARE_HYPERDRIVE_ID
```

`CLOUDFLARE_HYPERDRIVE_ID` is consumed by the deploy wrapper to generate a
temporary Wrangler config with the `AGENT_OUTBOX_DATABASE` Hyperdrive binding;
it is not installed into the Worker runtime as an environment variable.

## GitHub Storage Of Non-Secret Provider Ids

The repository is publicly readable, and GitHub Actions run logs follow that
visibility. Actions masks registered secrets in logs but prints the resolved
`env:` block of every step, so an environment _variable_ referenced by a step
appears in cleartext in a public log.

These four values are non-secret Worker configuration, but they are internal
provider resource ids that this runbook keeps out of public surfaces. Store them
as GitHub **environment secrets**, not environment variables, so Actions masks
them:

```text
CLOUDFLARE_HYPERDRIVE_ID
STRIPE_PAID_MONTHLY_PRICE_ID
STRIPE_PAID_YEARLY_PRICE_ID
STRIPE_BILLING_PORTAL_CONFIGURATION_ID
```

This changes only where GitHub stores them. They remain non-secret Worker
configuration and are still passed to Wrangler as deploy-time `--var` bindings,
and Systems Manager Parameter Store remains their canonical source.

`CLERK_PUBLISHABLE_KEY`, `SENTRY_BROWSER_DSN`, and
`NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN` stay GitHub environment variables:
all three are served to browsers, so masking them in logs would protect nothing.
`SENTRY_ORG` and `SENTRY_PROJECT` also stay variables; their values are
`conn-castle` and `agent-outbox`, and registering strings that common as log
masks would redact unrelated log output.

The production database host is not an environment value at all — Flyway prints
its own connection banner. The deploy workflow derives the host from
`DATABASE_MIGRATION_URL` and registers it with `::add-mask::` before the first
Flyway step, and fails closed if the host cannot be parsed.

Runtime secrets:

```text
CLERK_SECRET_KEY
SENTRY_DSN
CALLER_KEY_HASH_SECRET
SMOKE_OR_CLEANUP_TOKEN
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

`wrangler.jsonc` declares these true Worker secrets under `secrets.required`.
The production deploy wrapper writes only these names to a temporary dotenv
secrets file outside the repository and passes it to Wrangler with
`--secrets-file`; these values are not passed to the OpenNext build subprocess.
The file is removed after the deploy attempt. The pinned Wrangler dry-run did
not reject a dummy secrets file missing one required name, so treat the repo
deploy wrapper's required-environment check and the structural smoke guard as
the enforced inventory checks.

Do not install `DATABASE_APP_ROLE_URL` as a production Worker secret. Production
database access is through the `AGENT_OUTBOX_DATABASE` Hyperdrive binding
created from `CLOUDFLARE_HYPERDRIVE_ID`; direct database URLs remain for local
Node execution, migration replay, and provider recovery outside the Worker.

Do not install operator, deploy, migration, source-map upload, or local CLI
variables into the Worker runtime. Excluded examples include `AWS_PROFILE`,
`CLOUDFLARE_*` other than the deploy-time Hyperdrive config id, `DATABASE_URL`,
`DATABASE_APP_ROLE_URL`, `DATABASE_MIGRATION_URL`, `SUPABASE_PROJECT_REF`,
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
`AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD`, `AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH`,
`AGENT_OUTBOX_HOSTED_HEALTH_*`, `AGENT_OUTBOX_BILLING_SMOKE_*`, other
`AGENT_OUTBOX_*`, and `PORT`.

`CLOUDFLARE_WAF_API_TOKEN` is the operator credential for maintaining the
always-on `/api/client-events` rule through `scripts/cloudflare-ratelimit.mjs`.
It is not a Worker runtime secret. Store its narrow WAF/Rulesets token in SSM at
`/agent-outbox/environments/production/cloudflare-waf-api-token` and decrypt it
only into the operator process that applies or verifies the rule.

## Stripe Production Recovery Names

Production Stripe billing recovery uses these Systems Manager Parameter Store
names:

```text
/agent-outbox/environments/production/stripe-account-id
/agent-outbox/environments/production/stripe-secret-key
/agent-outbox/environments/production/stripe-product-id
/agent-outbox/environments/production/stripe-paid-monthly-price-id
/agent-outbox/environments/production/stripe-paid-yearly-price-id
/agent-outbox/environments/production/stripe-billing-portal-configuration-id
/agent-outbox/environments/production/stripe-webhook-endpoint-id
/agent-outbox/environments/production/stripe-webhook-secret
```

Use `SecureString` for the Stripe secret key and webhook secret. The
`stripe-secret-key` parameter is for the production runtime key used by the app
to create Checkout and Billing Portal sessions. Do not store setup-only Stripe
keys in that recovery path. Runtime also needs the corresponding Cloudflare
Worker environment values consumed by the app plus
`PUBLIC_APP_BASE_URL=https://app.agent-outbox.dev`.

As of Stripe docs checked on 2026-07-08, restricted API keys are created in the
Stripe Dashboard, not through the local CLI. Create the live restricted runtime
key there, copy it once into the approved operator-controlled secret flow, and
store it as the `stripe-secret-key` `SecureString`.

Setup-only Stripe operator keys use a separate `SecureString` recovery path:

```text
/agent-outbox/environments/production/stripe-setup-secret-key
```

This setup key can create or rotate billing objects, but it is not the runtime
Checkout/Portal key consumed by the app.

## Safe Inspection

List parameter names without decrypting values:

```bash
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/agent-outbox/" \
  --profile conn \
  --query 'Parameters[].Name' --output text
```

List GitHub environment secret names:

```bash
gh secret list -R <owner>/<agent-outbox-repo> --env production
```

List GitHub production environment variable names without printing values:

```bash
gh variable list -R <owner>/<agent-outbox-repo> --env production
```

Decrypt values only during recovery or rotation. Do not paste decrypted values
into chat, issues, logs, or docs.

## Direct SSM-backed operator commands

Use `scripts/run-with-ssm-secrets.mjs` when a local operator command needs a
managed production secret. Named sets load only the required parameters into the
child process from SSM; they do not create a plaintext cache.

Inspect unresolved production Sentry issues:

```bash
pnpm run sentry -- issues list --query 'is:unresolved' --max-rows 100
```

Production database credentials are not exposed through this local wrapper.
Production Flyway migrations run only inside the protected formal release
workflow; see [migrations.md](migrations.md).

## Recovery Flow

When a runtime or deployment copy is lost or differs from SSM:

1. Confirm which service consumes the value and whether the source service can
   safely regenerate it.
2. Treat the current SSM value as authoritative unless a deliberate provider
   rotation is in progress.
3. Read the parameter with decryption only inside a private operator process.
4. Set the value into the consuming service's downstream secret store.
5. Redeploy or restart the runtime only as required by that service.
6. If the value was exposed outside an operator-controlled shell, rotate it at
   the source service and update Systems Manager Parameter Store in the same
   operation window.

Use the protected production release workflow in
[services/cloudflare.md](services/cloudflare.md) so first deploys and rotations
upload code and runtime secrets together through the internal deploy wrapper's
`--secrets-file`. Do not use a local development `.env` as the production
secrets source or run the wrapper locally.

For production Worker setup, do not populate Cloudflare runtime values from a
local development `.env`. Recover or rotate production values through Systems
Manager Parameter Store and the source provider, then install them into
Cloudflare in the same operation window. If Parameter Store access is expired or
incomplete, production Worker deployment remains blocked rather than falling
back to development values.

## Rotation Rules

- Rotate Clerk, Stripe, Sentry, Cloudflare, GitHub deploy, and Supabase
  credentials at the issuing provider.
- Update Systems Manager Parameter Store before updating downstream copies.
- Update and verify every runtime or deployment copy against the new canonical
  value.
- Revoke the old value after the new value is live.
- Caller API keys are never recovered. Use `agent-outbox caller rotate` after
  the CLI exists.
