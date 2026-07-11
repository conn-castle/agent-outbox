create index concurrently if not exists agent_outbox_stripe_webhook_events_completed_idx
  on public.agent_outbox_stripe_webhook_events(processed_at);

comment on index public.agent_outbox_stripe_webhook_events_completed_idx is
  'Supports scheduled pruning of completed Stripe webhook idempotency events after the billing replay safety window.';
