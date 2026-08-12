alter table public.agent_outbox_accounts
  add column stripe_last_event_created_at timestamptz;

comment on column public.agent_outbox_accounts.stripe_last_event_created_at is
  'Created time of the last Stripe event applied to this account billing projection. Equal-second events retain delivery order.';
