# Stripe

## Tool

Use the official Stripe CLI: `stripe`.

Run `stripe --help` first, then run command-specific help before using flags
that are not already proven in this repository.

## Owns

- Account-scoped billing.
- Products and prices for hosted tiers.
- Checkout.
- Billing portal.
- Webhook endpoints and webhook delivery inspection.
- Cancellation, downgrade, payment failure, and grace-period state.

## Safe Checks

- Verify account mode before inspecting production.
- Use the Stripe CLI for billing object inspection, webhook delivery checks,
  event inspection, and API log tailing.
- Use `make billing-smoke` for no-charge hosted billing wiring checks. The
  command requires a valid operator-provided Clerk session cookie before it can
  create hosted Checkout sessions. Billing Portal smoke also requires an
  existing Stripe customer fixture and returns `action_required` when the smoke
  account has no customer. Full live completion is a separate owner-approved
  billing operation.
- Use read-only checks first when debugging checkout, webhook, portal,
  cancellation, downgrade, or grace behavior.
- Local/test-mode PR verification must cover successful checkout,
  payment-failure grace, webhook replay safety, and expired-grace downgrade
  cleanup before billing changes merge, unless the missing credentials or
  configuration are recorded as an explicit human checkpoint.

## Production Billing Shape

Production billing uses one account-scoped hosted paid product:

- Product: `Agent Outbox Hosted Paid`
- Monthly price lookup key: `agent_outbox_hosted_paid_monthly`, USD 500 cents,
  recurring monthly.
- Yearly price lookup key: `agent_outbox_hosted_paid_yearly`, USD 5000 cents,
  recurring yearly.
- Billing portal: invoice history, payment method update, cancellation at period
  end, and subscription updates only between the Agent Outbox monthly and yearly
  prices.
- Webhook URL: `https://app.agent-outbox.dev/api/billing/webhook`
- Webhook events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, and
  `invoice.payment_failed`.

Agent Outbox uses Stripe-hosted redirect Checkout and the hosted Billing Portal,
not embedded Checkout or Elements. Stripe payment method domain registration is
therefore not part of the current hosted redirect flow. If Agent Outbox later
uses Embedded Checkout, Elements, or wallet payment methods that require domain
registration, verify or create `app.agent-outbox.dev` through Stripe Payment
Method Domains first. Official Stripe references:
<https://docs.stripe.com/api/payment_method_domains/list> and
<https://docs.stripe.com/payments/payment-methods/pmd-registration>.

Webhook event ids are claimed inside the same database transaction that applies
their billing changes. A committed ledger row therefore means the event
completed; transaction rollback removes both the claim and billing changes so
Stripe can retry. During the expand/deploy compatibility window, the schema
retains `processing_status` with a `processed` default. The new writer
explicitly writes `processing_status = 'processed'` and `processed_at = now()`,
which is valid on both the pre-migration schema (NOT NULL, no default) and the
migrated schema, so deploying this release and applying its migrations are
order-independent. The webhook writer reads the receipt order assigned by the
expanded ledger: before that migration it retains the prior projection behavior,
and after the migration it atomically rejects strictly older projection updates
while using receipt order to break equal-second ties. Existing projections start
from a conservative floor derived from their latest associated ledger receipt.
If a prior or rollback writer changes billing state without advancing the new
tie-breaker, the database clears that floor so it cannot falsely suppress later
events after the new writer returns. The prior writer can still explicitly write
`processing` and transition it to `processed` inside the same transaction. No
intermediate state is durably committed. Drop the compatibility column only in a
later reviewed contract migration after this release is live and the rollback
target no longer needs the prior writer; that contract migration must also
remove the new writer's explicit column write and replace the prune function's
`processing_status` predicate. The ledger stores no raw webhook payload. Signed
events whose required `created` ordering metadata violates the Stripe event
contract fail before ledger insertion and return a retry-visible `503`; they are
not recorded as successfully processed or silently discarded.

Creating or rotating production billing resources requires a setup-only live
Stripe key with write permission for products, prices, Customer Portal
Configurations, and webhook endpoints. A read-only or otherwise restricted live
key can inspect resources but cannot create or rotate billing resources.

Setup-only keys are operator credentials for creating Stripe objects. Do not
store a setup-only key as `STRIPE_SECRET_KEY` or in the production
`stripe-secret-key` recovery path. If a setup key must be recoverable, store it
only in the setup-key recovery path documented in
[../secrets.md](../secrets.md). Production Checkout and Billing Portal sessions
use the separate restricted runtime key installed in Cloudflare Worker secrets.

Test-mode Stripe resources created for verification are disposable unless the
owner explicitly promotes a reusable test fixture. Record test-mode evidence,
but do not store disposable test-mode price ids or webhook secrets in Systems
Manager Parameter Store.

## Guardrails

- Do not create, update, delete, resend, or replay billing objects/events unless
  the task explicitly requires it.
- Do not change prices, billing terms, product ids, portal configuration, or
  webhook endpoints without owner approval.
- Do not paste customer billing data or secret keys into chat, issues, logs, or
  docs.
