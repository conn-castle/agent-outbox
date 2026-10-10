-- Additive: outgoing writers can continue using the expanded account schema.
-- Cleanup clears provider status; retain confirmed terminal identity separately.
alter table public.agent_outbox_accounts
  add column stripe_terminal_subscription_id text;

create table public.agent_outbox_billing_checkout_attempts (
  account_id uuid primary key references public.agent_outbox_accounts(account_id) on delete cascade,
  attempt_id uuid not null unique,
  billing_interval text not null check (billing_interval in ('monthly', 'yearly')),
  creation_parameters jsonb not null check (jsonb_typeof(creation_parameters) = 'object'),
  stripe_api_version text not null check (stripe_api_version <> ''),
  stripe_session_id text unique,
  stripe_subscription_id text,
  created_at timestamptz not null default now()
);

alter table public.agent_outbox_billing_checkout_attempts enable row level security;
alter table public.agent_outbox_billing_checkout_attempts force row level security;

create policy agent_outbox_billing_checkout_attempts_human
  on public.agent_outbox_billing_checkout_attempts
  for all
  using (
    public.agent_outbox_context_auth_surface() = 'human'
    and account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_has_account_membership()
  )
  with check (
    public.agent_outbox_context_auth_surface() = 'human'
    and account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_has_account_membership()
  );

create policy agent_outbox_billing_checkout_attempts_control_plane
  on public.agent_outbox_billing_checkout_attempts
  for all
  using (public.agent_outbox_context_auth_surface() = 'control_plane')
  with check (public.agent_outbox_context_auth_surface() = 'control_plane');

revoke all on public.agent_outbox_billing_checkout_attempts from public;
grant select, insert, update on public.agent_outbox_billing_checkout_attempts
  to agent_outbox_app;
