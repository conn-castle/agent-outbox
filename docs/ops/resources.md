# Resource Inventory

This file records public surfaces and service ownership for the hosted service.
Do not commit secret values, provider resource ids, account ids, project refs,
database hosts, or other environment-specific resource values to public
Markdown.

## Public Surfaces

| Surface                             | Location                           | Notes                                                                                                  |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Public website and docs             | `https://agent-outbox.dev`         | Public product and documentation surface.                                                              |
| Hosted app and caller API           | `https://app.agent-outbox.dev`     | Cloudflare Worker route for the app, auth-adjacent pages, caller registration, and `/api/...` routes.  |
| Caller API base                     | `https://app.agent-outbox.dev/api` | HTTP is the canonical caller contract.                                                                 |
| Support, privacy, and abuse contact | `https://agent-outbox.dev/contact` | Public contact form delivered through Cloudflare Email Service to the Agent Outbox inbox in Zoho Mail. |

## Service Resources

Record service ownership here. Verify exact provider identifiers through the
provider console, official CLI, approved secret store, or agent-layer memory
when temporary project state is needed.

| Service                             | Owns                                                                                            | Provider facts to verify                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| GitHub                              | Source, Actions deploy workflows, environments, deploy secrets, branch protection               | repository, workflow, environment, and branch-protection posture         |
| Cloudflare                          | DNS, Workers/OpenNext runtime, routes, logs, Email Service, Web Analytics, edge safety controls | account, Worker, route, zone, DNS, email-sending domain, and log posture |
| Supabase                            | Postgres database, queue state, file bytes, service logs                                        | organization, project, database, app-role, and migration-role posture    |
| Clerk                               | Human auth, signup protections, auth pages                                                      | application, instance, domain, sender, bot, and disposable-email posture |
| Stripe                              | Account-scoped billing                                                                          | account mode, product, price, portal, and webhook posture                |
| Sentry                              | Application exception grouping, releases, source maps                                           | organization, project, data source, and release posture                  |
| Zoho Mail                           | Public support, privacy, legal, and abuse contact inbox                                         | domain, mailbox, and contact-form delivery posture                       |
| AWS Systems Manager Parameter Store | Durable hosted-secret recovery                                                                  | AWS account, region, profile, parameter prefix, and KMS posture          |

Use [services/cloudflare.md](services/cloudflare.md),
[services/supabase.md](services/supabase.md),
[services/clerk.md](services/clerk.md),
[services/stripe.md](services/stripe.md), and
[services/sentry.md](services/sentry.md) for service-specific official CLI
guidance.

Use [release.md](release.md) for final release gates, hosted smoke and health
checks, billing smoke, rollback boundaries, and branch-protection policy.

Use [privacy-data-inventory.md](privacy-data-inventory.md) as the engineering
source for the public Privacy Policy's data, processor, and retention claims.

## Deployment Boundary

The human review UI, Clerk-backed auth-adjacent pages, caller registration
flows, scheduled cleanup routes, and caller API endpoints deploy as one Next.js
app on Cloudflare Workers through OpenNext.

The production Worker is configured in `wrangler.jsonc` as `agent-outbox`.
`agent-outbox.dev` is the public website Custom Domain, `app.agent-outbox.dev`
is the app/API Custom Domain, and the scheduled Worker cron is `17 * * * *`. The
Worker `workers.dev` route is disabled so those custom domains remain the only
hosted website and app/API surfaces. Exact account, zone, token, deployment, and
secret values stay in Cloudflare, GitHub environment secrets, and Systems
Manager Parameter Store rather than tracked Markdown.

GitHub Actions is the canonical deployment path. This file records targets and
ownership; it does not duplicate workflow steps.
