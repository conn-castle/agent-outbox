create table public.agent_outbox_caller_setup_requests (
  setup_request_id uuid primary key default extensions.gen_random_uuid(),
  operation text not null
    check (operation in ('connect', 'rotate', 'revoke')),
  flow text not null check (flow in ('browser', 'device')),
  local_caller_name text not null,
  display_name text not null,
  callback_url text,
  device_code_hash text,
  user_code_hash text,
  setup_code_hash text,
  account_id uuid references public.agent_outbox_accounts(account_id) on delete cascade,
  caller_id uuid references public.agent_outbox_callers(caller_id) on delete cascade,
  approved_by_user_id uuid references public.agent_outbox_users(user_id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'exchanged', 'expired', 'denied')),
  poll_interval_seconds integer not null default 5
    check (poll_interval_seconds between 1 and 3600),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  exchanged_at timestamptz,
  denied_at timestamptz,
  check (local_caller_name = btrim(local_caller_name) and local_caller_name <> ''),
  check (display_name = btrim(display_name) and display_name <> ''),
  check (device_code_hash is null or device_code_hash ~ '^[a-f0-9]{64}$'),
  check (user_code_hash is null or user_code_hash ~ '^[a-f0-9]{64}$'),
  check (setup_code_hash is null or setup_code_hash ~ '^[a-f0-9]{64}$'),
  check (
    (flow = 'browser'
      and callback_url is not null
      and device_code_hash is null
      and user_code_hash is null)
    or
    (flow = 'device'
      and callback_url is null
      and device_code_hash is not null
      and user_code_hash is not null)
  ),
  foreign key (account_id, caller_id)
    references public.agent_outbox_callers(account_id, caller_id)
);

create unique index agent_outbox_caller_setup_requests_setup_code_idx
  on public.agent_outbox_caller_setup_requests(setup_code_hash)
  where setup_code_hash is not null;

create unique index agent_outbox_caller_setup_requests_device_code_idx
  on public.agent_outbox_caller_setup_requests(device_code_hash)
  where device_code_hash is not null;

create unique index agent_outbox_caller_setup_requests_active_user_code_idx
  on public.agent_outbox_caller_setup_requests(user_code_hash)
  where user_code_hash is not null
    and status in ('pending', 'approved');

create index agent_outbox_caller_setup_requests_status_expiry_idx
  on public.agent_outbox_caller_setup_requests(status, expires_at);

create index agent_outbox_caller_setup_requests_account_idx
  on public.agent_outbox_caller_setup_requests(account_id, operation, status);

alter table public.agent_outbox_caller_credentials
  add column pending_replacement_for_credential_id uuid,
  add column pending_replacement_setup_request_id uuid references public.agent_outbox_caller_setup_requests(setup_request_id) on delete cascade,
  add constraint agent_outbox_pending_replacement_not_self
    check (
      pending_replacement_for_credential_id is null
      or pending_replacement_for_credential_id <> caller_credential_id
    ),
  add constraint agent_outbox_pending_replacement_shape
    check (
      (
        pending_replacement_for_credential_id is null
        and pending_replacement_setup_request_id is null
      )
      or
      (
        status = 'pending_activation'
        and pending_replacement_for_credential_id is not null
        and pending_replacement_setup_request_id is not null
        and expires_at is not null
      )
    );

create unique index agent_outbox_caller_credentials_account_caller_credential_idx
  on public.agent_outbox_caller_credentials(account_id, caller_id, caller_credential_id);

alter table public.agent_outbox_caller_credentials
  add constraint agent_outbox_pending_replacement_same_caller_fk
    foreign key (account_id, caller_id, pending_replacement_for_credential_id)
    references public.agent_outbox_caller_credentials(account_id, caller_id, caller_credential_id)
    on delete cascade;

create unique index agent_outbox_one_pending_replacement_per_caller
  on public.agent_outbox_caller_credentials(caller_id)
  where status = 'pending_activation'
    and pending_replacement_for_credential_id is not null;

create unique index agent_outbox_pending_replacement_setup_request_idx
  on public.agent_outbox_caller_credentials(pending_replacement_setup_request_id)
  where pending_replacement_setup_request_id is not null;

create table public.agent_outbox_ip_quota_windows (
  ip_address inet not null,
  metric text not null,
  window_kind text not null check (window_kind in ('minute', 'day', 'calendar_month')),
  window_start_utc timestamptz not null,
  used_units bigint not null default 0 check (used_units >= 0),
  updated_at timestamptz not null default now(),
  primary key (ip_address, metric, window_kind, window_start_utc)
);

create index agent_outbox_ip_quota_windows_updated_at_idx
  on public.agent_outbox_ip_quota_windows(updated_at);

create or replace function public.agent_outbox_prune_ip_quota_windows(
  p_before timestamptz
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  if public.agent_outbox_context_auth_surface() <> 'cleanup' then
    raise exception 'agent_outbox_prune_ip_quota_windows forbidden'
      using errcode = '42501';
  end if;

  delete from public.agent_outbox_ip_quota_windows
  where updated_at < p_before;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.agent_outbox_prune_caller_setup_requests(
  p_before timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  if public.agent_outbox_context_auth_surface() <> 'cleanup' then
    raise exception 'agent_outbox_prune_caller_setup_requests forbidden'
      using errcode = '42501';
  end if;

  delete from public.agent_outbox_caller_setup_requests setup
  where (
      (
        setup.status in ('exchanged', 'expired', 'denied')
        and setup.updated_at < p_before
      )
      or (
        setup.status in ('pending', 'approved')
        and setup.expires_at < p_before
      )
    )
    and not exists (
      select 1
      from public.agent_outbox_caller_credentials credential
      where credential.pending_replacement_setup_request_id = setup.setup_request_id
    );

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

alter table public.agent_outbox_caller_setup_requests enable row level security;
alter table public.agent_outbox_ip_quota_windows enable row level security;

alter table public.agent_outbox_caller_setup_requests force row level security;
alter table public.agent_outbox_ip_quota_windows force row level security;

create policy agent_outbox_caller_setup_requests_control_plane_or_human
  on public.agent_outbox_caller_setup_requests
  for all
  using (
    public.agent_outbox_context_auth_surface() = 'control_plane'
    or public.agent_outbox_context_auth_surface() = 'cleanup'
    or (
      account_id is not null
      and public.agent_outbox_context_allows_account(account_id)
    )
    or (
      account_id is null
      and public.agent_outbox_context_auth_surface() = 'human'
      and public.agent_outbox_context_has_account_membership()
    )
  )
  with check (
    public.agent_outbox_context_auth_surface() = 'control_plane'
    or (
      account_id is not null
      and public.agent_outbox_context_allows_account(account_id)
    )
    or (
      account_id is null
      and public.agent_outbox_context_auth_surface() = 'human'
      and public.agent_outbox_context_has_account_membership()
    )
  );

create policy agent_outbox_ip_quota_windows_control_plane
  on public.agent_outbox_ip_quota_windows
  for all
  using (public.agent_outbox_context_auth_surface() in ('control_plane', 'cleanup'))
  with check (public.agent_outbox_context_auth_surface() = 'control_plane');

revoke execute on function public.agent_outbox_prune_ip_quota_windows(timestamptz) from public;
revoke execute on function public.agent_outbox_prune_caller_setup_requests(timestamptz) from public;
grant execute on function public.agent_outbox_prune_ip_quota_windows(timestamptz) to agent_outbox_app;
grant execute on function public.agent_outbox_prune_caller_setup_requests(timestamptz) to agent_outbox_app;

revoke all on
  public.agent_outbox_caller_setup_requests,
  public.agent_outbox_ip_quota_windows
from public;

do $$
  declare
    provider_role text;
    app_functions constant text := '
    public.agent_outbox_prune_ip_quota_windows(timestamptz),
    public.agent_outbox_prune_caller_setup_requests(timestamptz)
  ';
  app_tables constant text := '
    public.agent_outbox_caller_setup_requests,
    public.agent_outbox_ip_quota_windows
  ';
begin
  foreach provider_role in array array[
    'anon',
    'authenticated',
    'service_role'
  ] loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = provider_role
    ) then
      execute format(
        'revoke execute on function %s from %I',
        app_functions,
        provider_role
      );
      execute format('revoke all on %s from %I', app_tables, provider_role);
    end if;
  end loop;
end
$$;

grant select, insert, update, delete on
  public.agent_outbox_caller_setup_requests,
  public.agent_outbox_ip_quota_windows
to agent_outbox_app;

comment on table public.agent_outbox_caller_setup_requests is
  'Human-approved caller control-plane setup state. Stores hashed setup/device/user codes only; plaintext codes are display-once.';

comment on table public.agent_outbox_ip_quota_windows is
  'DB-backed fixed-window abuse accounting for unauthenticated connect control-plane routes keyed by trusted client IP, metric, window kind, and window start.';

comment on function public.agent_outbox_prune_caller_setup_requests(timestamptz) is
  'Deletes bounded-retention caller setup requests while preserving setup requests referenced by pending replacement credentials.';

comment on column public.agent_outbox_caller_credentials.pending_replacement_for_credential_id is
  'For rotate flows, the active credential this pending replacement will replace after CLI local storage succeeds.';

comment on column public.agent_outbox_caller_credentials.pending_replacement_setup_request_id is
  'For rotate flows, the human-approved setup request that produced this pending replacement credential.';
