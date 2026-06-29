# Resource Inventory

This file records the concrete resources where the hosted service runs. Exact
identifiers must come from configured Agent Outbox resources, not guesses or
another project.

## Public Surfaces

| Surface                   | Location                           | Notes                                                                                                 |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Public website and docs   | `https://agent-outbox.dev`         | Public product and documentation surface.                                                             |
| Hosted app and caller API | `https://app.agent-outbox.dev`     | Cloudflare Worker route for the app, auth-adjacent pages, caller registration, and `/api/...` routes. |
| Caller API base           | `https://app.agent-outbox.dev/api` | HTTP is the canonical caller contract.                                                                |
| Persistent staging        | None currently                     | Add this row only when a real staging environment exists.                                             |

## Service Resources

Record exact production names, ids, CLI-visible identifiers, and regions in the
operator-controlled resource inventory when each resource exists. Do not commit
secret values.

| Service                             | Owns                                                                              | Production identifiers to record                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| GitHub                              | Source, Actions deploy workflows, environments, deploy secrets, branch protection | repository slug, workflow names, environment names, protected branches                  |
| Cloudflare                          | DNS, Workers/OpenNext runtime, routes, logs, Web Analytics, edge safety controls  | account id/name, Worker name, route names, zone, DNS records, log settings              |
| Supabase                            | Postgres database, queue state, file bytes, service logs                          | organization, project ref, database host, configured app and migration roles            |
| Clerk                               | Human auth, signup protections, auth pages                                        | application/instance ids, domains, sender identities, bot and disposable-email settings |
| Stripe                              | Account-scoped billing                                                            | account mode, product, prices, portal config, webhook endpoint                          |
| Sentry                              | Application exception grouping, releases, source maps                             | organization, project, server/browser data source names, release setup                  |
| AWS Systems Manager Parameter Store | Durable hosted-secret recovery                                                    | AWS account, region, profile, parameter prefixes, KMS posture                           |

Use [services/cloudflare.md](services/cloudflare.md),
[services/supabase.md](services/supabase.md),
[services/clerk.md](services/clerk.md),
[services/stripe.md](services/stripe.md), and
[services/sentry.md](services/sentry.md) for service-specific official CLI
guidance.

## Deployment Boundary

The human review UI, Clerk-backed auth-adjacent pages, caller registration
flows, scheduled cleanup routes, and caller API endpoints deploy as one Next.js
app on Cloudflare Workers through OpenNext.

GitHub Actions is the canonical deployment path. This file records targets and
ownership; it does not duplicate workflow steps.
