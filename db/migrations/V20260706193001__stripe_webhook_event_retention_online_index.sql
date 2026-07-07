create index concurrently if not exists agent_outbox_stripe_webhook_events_processed_idx
  on public.agent_outbox_stripe_webhook_events(processed_at)
  where processing_status = 'processed'
    and processed_at is not null;

comment on index public.agent_outbox_stripe_webhook_events_processed_idx is
  'Supports scheduled pruning of processed Stripe webhook idempotency events after the billing replay safety window.';
