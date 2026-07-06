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

Creating or rotating production billing resources requires a setup-only live
Stripe key with write permission for products, prices, Customer Portal
Configurations, and webhook endpoints. A read-only or otherwise restricted live
key can inspect resources but cannot complete Phase 7 billing setup.

Setup-only keys are operator credentials for creating Stripe objects. Do not
store a setup-only key as `STRIPE_SECRET_KEY` or in the production
`stripe-secret-key` recovery path. If a setup key must be recoverable, store it
only in the setup-key recovery path documented in
[../secrets.md](../secrets.md). Production Checkout and Billing Portal sessions
need a separate runtime restricted key when Cloudflare runtime secrets are
installed.

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
