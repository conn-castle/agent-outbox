# Incidents

Agent Outbox is a temporary review and delivery queue. It fails loud, uses hard
product limits, and relies on service-level controls during severe incidents.
The current hosted product does not include an app-owned runtime kill switch,
admin control table, or partial operation-disable system.

## First Response

1. Identify the affected surface: public site, app UI, caller API, auth,
   database, billing, file upload/download, cleanup, or logs.
2. Capture UTC time window, release SHA/version, user-visible `error_id`,
   affected account/caller if known, and service CLI checks run.
3. Stop deploying unrelated changes until the incident is understood.
4. Check Sentry, Cloudflare Workers logs, Supabase logs, and Stripe or Clerk as
   applicable using the service docs under [services/](services/).
5. Prefer service-level containment for active abuse or traffic floods.
6. Do not run destructive database operations, account deletion, or audit-event
   mutation without explicit operator approval.

## Service-Level Controls

Use these controls when the app is unhealthy or abused:

| Incident type                                 | Control                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Request flood or abusive unauthenticated path | Cloudflare WAF, rate-limit, challenge rule, or route-level block.                                                                           |
| Signup abuse                                  | Clerk Bot sign-up protection, disposable-email blocking, restricted access, or temporary signup gating.                                     |
| Caller API abuse                              | Revoke caller keys, add Cloudflare edge controls, adjust product limits, or block abusive accounts/callers in app data after investigation. |
| Database exhaustion                           | Supabase service controls, cleanup jobs, account/caller revocation, or app deploy to reduce write pressure.                                 |
| Bad deploy                                    | Cloudflare deployment rollback or config rollback after checking migration compatibility.                                                   |
| Secret exposure                               | Rotate at source service, update Systems Manager Parameter Store and runtime stores, redeploy/restart as required.                          |

`output ack` is conceptually a cleanup operation, but the product does not build
custom partial-degradation machinery just to keep ack available during every
service incident.

## Common Incident Paths

### App outage

- Check Cloudflare Worker status, latest deployment, route/DNS config, and
  Workers logs using [services/cloudflare.md](services/cloudflare.md).
- Check Sentry unresolved issues for the deploy window.
- Check Supabase connectivity if requests fail after app boot.
- Roll back app code/config if the issue started with a deploy and migrations
  are compatible.
- Use the rollback boundaries in [release.md](release.md) before changing
  production deploy or branch-protection posture.

### Auth outage or signup abuse

- Check Clerk status, instance config, domains, and email delivery using
  [services/clerk.md](services/clerk.md).
- Confirm bot protection and disposable-email blocking are enabled before broad
  public signup.
- For abuse, prefer Clerk controls before adding app-owned signup code.
- Do not block plus-addressed emails by default unless the owner approves it as
  an abuse response.

### Caller API abuse

- Use quota counters, limit blocks, audit events, and structured logs to
  identify account and caller patterns.
- Cleanup operations `input delete` and `output ack` are exempt from the monthly
  caller API request quota but still may have narrow burst controls.
- Revoke abusive caller keys through the product/API path.

### Database storage or connection incident

- Supabase Postgres owns queue rows, output rows, uploaded file bytes, quota
  windows, limit blocks, and audit events.
- Watch storage closely because paid file bytes are stored in Postgres.
- Do not use raw SQL to modify schema. Use the Flyway rules in
  [migrations.md](migrations.md).
- Do not delete live data manually unless the owner approves the exact scope and
  backup/export posture.

### Billing incident

- Use Stripe webhook delivery logs through
  [services/stripe.md](services/stripe.md) first.
- Check app logs for webhook signature or handler failures.
- Run `make billing-smoke` only in its no-charge default mode unless the owner
  approves a full live completion protocol.
- Stripe billing state is account-scoped, not seat- or caller-scoped.
- Apply the grace behavior documented in
  [../architecture.md](../architecture.md) before enforcing lower-tier limits.

### Sensitive data in logs or audit events

- Stop the code path that emits the sensitive data.
- Preserve enough evidence to understand scope without redistributing the data.
- Decide with the owner whether break-glass audit mutation is required.
- Rotate any exposed secrets at the source service.

## Escalation Boundaries

Stop and ask the owner before:

- destructive database repair;
- audit-event update/delete;
- production account deletion outside the normal browser-confirmed flow;
- changing public billing terms or paid-tier behavior;
- public legal/security notification;
- turning on invite-only/restricted access as a product posture rather than an
  emergency abuse response;
- adding a new vendor or external log sink.
