alter table public.agent_outbox_accounts
  add column stripe_customer_id text,
  add column stripe_subscription_id text,
  add column stripe_subscription_status text,
  add column stripe_price_id text,
  add column stripe_current_period_end timestamptz;

create unique index agent_outbox_accounts_stripe_customer_unique
  on public.agent_outbox_accounts(stripe_customer_id)
  where stripe_customer_id is not null;

create unique index agent_outbox_accounts_stripe_subscription_unique
  on public.agent_outbox_accounts(stripe_subscription_id)
  where stripe_subscription_id is not null;

create table public.agent_outbox_stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  processing_status text not null
    check (processing_status in ('processing', 'processed')),
  account_id uuid references public.agent_outbox_accounts(account_id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  check (stripe_event_id <> ''),
  check (event_type <> '')
);

create index agent_outbox_stripe_webhook_events_account_idx
  on public.agent_outbox_stripe_webhook_events(account_id, received_at);

alter table public.agent_outbox_stripe_webhook_events enable row level security;
alter table public.agent_outbox_stripe_webhook_events force row level security;

create policy agent_outbox_accounts_billing_control_plane
  on public.agent_outbox_accounts
  for select
  using (public.agent_outbox_context_auth_surface() = 'control_plane');

create policy agent_outbox_accounts_billing_control_plane_update
  on public.agent_outbox_accounts
  for update
  using (public.agent_outbox_context_auth_surface() = 'control_plane')
  with check (public.agent_outbox_context_auth_surface() = 'control_plane');

create policy agent_outbox_stripe_webhook_events_control_plane
  on public.agent_outbox_stripe_webhook_events
  for all
  using (public.agent_outbox_context_auth_surface() = 'control_plane')
  with check (public.agent_outbox_context_auth_surface() = 'control_plane');

revoke all on public.agent_outbox_stripe_webhook_events from public;

grant select, insert, update on public.agent_outbox_stripe_webhook_events
to agent_outbox_app;

comment on column public.agent_outbox_accounts.stripe_customer_id is
  'Stripe customer identifier for account-scoped hosted billing. Do not expose through status payloads.';

comment on column public.agent_outbox_accounts.stripe_subscription_id is
  'Stripe subscription identifier for account-scoped hosted billing. Do not expose through status payloads.';

comment on table public.agent_outbox_stripe_webhook_events is
  'Stripe webhook idempotency ledger. Stores event ids, types, status, and account linkage only; never raw payloads or customer billing data.';
