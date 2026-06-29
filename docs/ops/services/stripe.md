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

## Guardrails

- Do not create, update, delete, resend, or replay billing objects/events unless
  the task explicitly requires it.
- Do not change prices, billing terms, product ids, portal configuration, or
  webhook endpoints without owner approval.
- Do not paste customer billing data or secret keys into chat, issues, logs, or
  docs.
