# Secrets

## Policy

AWS Systems Manager Parameter Store is the durable recovery source for hosted
service secrets. Service-native stores are still the runtime injection path.

Do not make GitHub Actions fetch from Systems Manager Parameter Store during
normal deploys. Continuous integration and deployment use GitHub secrets.
Systems Manager Parameter Store exists so hosted environments can be recovered
and rotations do not depend on one service retaining the only copy.

Every secret provision or rotation must update both:

- the service runtime or continuous deployment secret store that consumes the
  value; and
- the matching Systems Manager Parameter Store parameter.

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

Use the configured Agent Outbox AWS account, region, KMS posture, and local
profile. Do not copy another project's AWS account or profile unless the owner
explicitly chooses that account for Agent Outbox.

## Ownership Matrix

| Secret class                                                | Runtime owner                                                 | Durable recovery owner                                         | Notes                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Worker runtime secrets                           | Cloudflare Workers                                            | Systems Manager Parameter Store                                | Install only the Worker runtime inventory below; [../../.env.example](../../.env.example) also includes local, operator, deploy, and migration variables. |
| Deploy credentials                                          | GitHub Actions secrets                                        | Systems Manager Parameter Store when not trivially re-mintable | Use least-scoped Cloudflare tokens for configured resources.                                                                                              |
| Supabase database URLs and role passwords                   | Supabase plus Cloudflare runtime/Flyway migration environment | Systems Manager Parameter Store                                | Use [migrations.md](migrations.md) for schema changes.                                                                                                    |
| Clerk secret keys                                           | Clerk plus Cloudflare runtime                                 | Systems Manager Parameter Store                                | Publishable keys may be GitHub/Cloudflare environment config, mirrored if needed for recovery.                                                            |
| Stripe secret key, webhook secret, price ids, portal config | Stripe plus Cloudflare runtime                                | Systems Manager Parameter Store                                | Test and live values are separate. Production uses live mode.                                                                                             |
| Sentry data source names and auth token                     | Sentry plus Cloudflare/GitHub as needed                       | Systems Manager Parameter Store                                | Runtime uses data source names only. Auth token is for source maps/operator tooling.                                                                      |
| Caller key hash secret (`CALLER_KEY_HASH_SECRET`)           | Cloudflare Worker runtime                                     | Systems Manager Parameter Store                                | Required to hash display-once caller API keys. Losing or changing it requires caller credential rotation or rehashing.                                    |
| Caller API keys                                             | Agent Outbox database hash plus local caller secure store     | Not Systems Manager Parameter Store                            | Plaintext caller keys are display-once and never recovered. Rotate instead.                                                                               |

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

Runtime secrets:

```text
DATABASE_APP_ROLE_URL
CLERK_SECRET_KEY
SENTRY_DSN
CALLER_KEY_HASH_SECRET
SMOKE_OR_CLEANUP_TOKEN
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

Do not install operator, deploy, migration, source-map upload, or local CLI
variables into the Worker runtime. Excluded examples include `AWS_PROFILE`,
`CLOUDFLARE_*`, `DATABASE_URL`, `DATABASE_MIGRATION_URL`,
`SUPABASE_PROJECT_REF`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
`AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD`, `AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH`,
`AGENT_OUTBOX_*`, and `PORT`.

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
  --profile <agent-outbox-aws-profile> \
  --region <agent-outbox-aws-region> \
  --query 'Parameters[].Name' --output text
```

List GitHub environment secret names:

```bash
gh secret list -R <owner>/<agent-outbox-repo> --env production
```

Decrypt values only during recovery or rotation. Do not paste decrypted values
into chat, issues, logs, or docs.

## Recovery Flow

When a runtime secret is lost:

1. Confirm which service consumes the value and whether the source service can
   safely regenerate it.
2. Prefer regeneration at the source service when it has no operational cost.
3. If recovery is needed, read the parameter with decryption in a private
   operator shell.
4. Set the value into the consuming service's secret store.
5. Redeploy or restart the runtime only as required by that service.
6. If the value was exposed outside an operator-controlled shell, rotate it at
   the source service and update Systems Manager Parameter Store in the same
   operation window.

Use the configured Cloudflare secret import/set commands for the Worker project
and the Wrangler invocation documented in
[services/cloudflare.md](services/cloudflare.md).

For production Worker setup, do not populate Cloudflare runtime values from a
local development `.env`. Recover or rotate production values through Systems
Manager Parameter Store and the source provider, then install them into
Cloudflare in the same operation window. If Parameter Store access is expired or
incomplete, production Worker deployment remains blocked rather than falling
back to development values.

## Rotation Rules

- Rotate Clerk, Stripe, Sentry, Cloudflare, GitHub deploy, and Supabase
  credentials at the source service.
- Update Systems Manager Parameter Store immediately after rotation.
- Verify the runtime consumes the new value.
- Revoke the old value after the new value is live.
- Caller API keys are never recovered. Use `agent-outbox caller rotate` after
  the CLI exists.
