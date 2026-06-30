do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'agent_outbox_app'
  ) then
    create role agent_outbox_app
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      noinherit
      nobypassrls;
  elsif exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'agent_outbox_app'
      and (
        rolsuper
        or rolcreatedb
        or rolcreaterole
        or rolreplication
        or rolbypassrls
        or rolinherit
      )
  ) then
    raise exception 'agent_outbox_app must be a restricted non-bypass role before migrations run';
  elsif exists (
    select 1
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles app_role
      on app_role.oid = membership.member
    where app_role.rolname = 'agent_outbox_app'
  ) then
    raise exception 'agent_outbox_app must not be a member of any role before migrations run';
  end if;
end
$$;

do $$
begin
  execute format(
    'revoke all privileges on database %I from agent_outbox_app',
    current_database()
  );
  execute format(
    'grant connect on database %I to agent_outbox_app',
    current_database()
  );
end
$$;

revoke all privileges on schema public from agent_outbox_app;
grant usage on schema public to agent_outbox_app;

comment on role agent_outbox_app is
  'Restricted Agent Outbox application role. Password is provisioned outside migrations.';

create schema if not exists extensions;
revoke all privileges on schema extensions from agent_outbox_app;
grant usage on schema extensions to agent_outbox_app;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.agent_outbox_context_account_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('agent_outbox.account_id', true), '')::uuid
$$;

create or replace function public.agent_outbox_context_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('agent_outbox.user_id', true), '')::uuid
$$;

create or replace function public.agent_outbox_context_caller_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('agent_outbox.caller_id', true), '')::uuid
$$;

create or replace function public.agent_outbox_context_auth_surface()
returns text
language sql
stable
as $$
  select nullif(current_setting('agent_outbox.auth_surface', true), '')
$$;

create table public.agent_outbox_accounts (
  account_id uuid primary key default extensions.gen_random_uuid(),
  account_audit_id uuid not null unique default extensions.gen_random_uuid(),
  label text,
  tier text not null default 'hosted_free'
    check (tier in ('hosted_free', 'hosted_paid', 'self_hosted')),
  billing_status text not null default 'not_applicable'
    check (
      billing_status in (
        'not_applicable',
        'active',
        'grace',
        'past_due',
        'canceled'
      )
    ),
  billing_grace_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.agent_outbox_users (
  user_id uuid primary key default extensions.gen_random_uuid(),
  user_audit_id uuid not null unique default extensions.gen_random_uuid(),
  clerk_user_id text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table public.agent_outbox_account_members (
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  user_id uuid not null references public.agent_outbox_users(user_id) on delete cascade,
  role text not null check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

create table public.agent_outbox_callers (
  caller_id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  caller_audit_id uuid not null unique default extensions.gen_random_uuid(),
  display_name text not null,
  caller_slug text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (account_id, caller_id),
  unique (account_id, caller_slug)
);

create or replace function public.agent_outbox_context_has_account_membership()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.agent_outbox_context_account_id() is not null
    and public.agent_outbox_context_user_id() is not null
    and exists (
      select 1
      from public.agent_outbox_account_members m
      where m.account_id = public.agent_outbox_context_account_id()
        and m.user_id = public.agent_outbox_context_user_id()
    )
$$;

create or replace function public.agent_outbox_context_allows_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case public.agent_outbox_context_auth_surface()
    when 'caller' then
      p_account_id = public.agent_outbox_context_account_id()
      and public.agent_outbox_context_caller_id() is not null
      and exists (
        select 1
        from public.agent_outbox_callers c
        where c.account_id = p_account_id
          and c.caller_id = public.agent_outbox_context_caller_id()
      )
    when 'human' then
      p_account_id = public.agent_outbox_context_account_id()
      and public.agent_outbox_context_has_account_membership()
    when 'cleanup' then p_account_id = public.agent_outbox_context_account_id()
    else false
  end
$$;

create or replace function public.agent_outbox_context_allows_caller(p_caller_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case public.agent_outbox_context_auth_surface()
    when 'caller' then
      public.agent_outbox_context_caller_id() is not null
      and p_caller_id = public.agent_outbox_context_caller_id()
    when 'human' then public.agent_outbox_context_has_account_membership()
    when 'cleanup' then true
    else false
  end
$$;

create or replace function public.agent_outbox_context_allows_caller_audit_id(p_caller_audit_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case public.agent_outbox_context_auth_surface()
    when 'caller' then exists (
      select 1
      from public.agent_outbox_callers c
      where c.account_id = public.agent_outbox_context_account_id()
        and c.caller_id = public.agent_outbox_context_caller_id()
        and c.caller_audit_id = p_caller_audit_id
    )
    when 'human' then
      public.agent_outbox_context_has_account_membership()
      and (
        p_caller_audit_id is null
        or exists (
          select 1
          from public.agent_outbox_callers c
          where c.account_id = public.agent_outbox_context_account_id()
            and c.caller_audit_id = p_caller_audit_id
        )
      )
    when 'cleanup' then true
    else false
  end
$$;

create table public.agent_outbox_caller_credentials (
  caller_credential_id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  caller_id uuid not null references public.agent_outbox_callers(caller_id) on delete cascade,
  key_id text not null unique,
  key_prefix text not null,
  key_last_four text not null,
  secret_hmac_sha256 text not null,
  status text not null
    check (status in ('pending_activation', 'active', 'revoked', 'expired')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  check (secret_hmac_sha256 ~ '^[a-f0-9]{64}$'),
  foreign key (account_id, caller_id)
    references public.agent_outbox_callers(account_id, caller_id)
);

create or replace function public.agent_outbox_lookup_caller_credential(p_key_id text)
returns table(
  account_id uuid,
  caller_id uuid,
  key_id text,
  key_prefix text,
  key_last_four text,
  secret_hmac_sha256 text,
  status text,
  revoked_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    credential.account_id,
    credential.caller_id,
    credential.key_id,
    credential.key_prefix,
    credential.key_last_four,
    credential.secret_hmac_sha256,
    credential.status,
    credential.revoked_at,
    credential.expires_at
  from public.agent_outbox_caller_credentials credential
  join public.agent_outbox_callers caller
    on caller.account_id = credential.account_id
   and caller.caller_id = credential.caller_id
  where credential.key_id = p_key_id
    and caller.revoked_at is null
  limit 1
$$;

create unique index agent_outbox_one_active_credential_per_caller
  on public.agent_outbox_caller_credentials(caller_id)
  where status = 'active';

create table public.agent_outbox_input_items (
  input_item_id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  caller_id uuid not null references public.agent_outbox_callers(caller_id) on delete cascade,
  caller_item_id text not null,
  caller_item_id_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'answered')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  current_revision integer not null default 1 check (current_revision > 0),
  row_type_display text not null,
  row_type_icon text not null,
  row_accent_color text,
  title_html text not null,
  subtitle_html text not null,
  corner_html text,
  summary_html text not null,
  details_html text,
  card_visual_kind text check (
    card_visual_kind is null
    or card_visual_kind in ('numeric_bar', 'pill', 'progress_ring')
  ),
  card_visual_payload jsonb not null default '{}'::jsonb,
  skip_disabled boolean not null default false,
  normalized_content_fingerprint text,
  non_file_payload_bytes bigint not null default 0 check (non_file_payload_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  answered_at timestamptz,
  foreign key (account_id, caller_id)
    references public.agent_outbox_callers(account_id, caller_id),
  unique (account_id, caller_id, input_item_id),
  unique (caller_id, caller_item_id)
);

create index agent_outbox_input_items_account_status_updated_idx
  on public.agent_outbox_input_items(account_id, status, updated_at);

create table public.agent_outbox_input_link_buttons (
  input_link_button_id uuid primary key default extensions.gen_random_uuid(),
  input_item_id uuid not null references public.agent_outbox_input_items(input_item_id) on delete cascade,
  display_order integer not null check (display_order >= 0),
  display text not null,
  icon text not null,
  url text not null,
  unique (input_item_id, display_order)
);

create table public.agent_outbox_input_actions (
  input_action_id uuid primary key default extensions.gen_random_uuid(),
  input_item_id uuid not null references public.agent_outbox_input_items(input_item_id) on delete cascade,
  display_order integer not null check (display_order >= 0),
  display text not null,
  icon text not null,
  action_value text not null,
  overflow boolean not null default false,
  popup_kind text not null
    check (
      popup_kind in (
        'none',
        'free_text',
        'single_select',
        'multi_select',
        'date_picker',
        'file_upload'
      )
    ),
  popup_payload jsonb not null default '{}'::jsonb,
  unique (input_item_id, display_order),
  unique (input_item_id, action_value)
);

create index agent_outbox_input_actions_popup_kind_idx
  on public.agent_outbox_input_actions(input_item_id, popup_kind);

create table public.agent_outbox_input_action_popup_options (
  input_action_popup_option_id uuid primary key default extensions.gen_random_uuid(),
  input_action_id uuid not null references public.agent_outbox_input_actions(input_action_id) on delete cascade,
  display_order integer not null check (display_order >= 0),
  display text not null,
  option_value text not null,
  icon text,
  unique (input_action_id, display_order),
  unique (input_action_id, option_value)
);

create table public.agent_outbox_output_results (
  output_result_id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  caller_id uuid not null references public.agent_outbox_callers(caller_id) on delete cascade,
  input_item_id uuid not null references public.agent_outbox_input_items(input_item_id) on delete cascade,
  caller_item_id text not null,
  action_value text not null,
  response_kind text not null
    check (
      response_kind in (
        'none',
        'free_text',
        'single_select',
        'multi_select',
        'date_picker',
        'file_upload'
      )
    ),
  response_payload jsonb not null default '{}'::jsonb,
  response_payload_bytes bigint not null default 0 check (response_payload_bytes >= 0),
  answered_at timestamptz not null default now(),
  answered_by_user_id uuid references public.agent_outbox_users(user_id) on delete set null,
  first_read_at timestamptz,
  read_count integer not null default 0 check (read_count >= 0),
  expires_at timestamptz not null,
  unique (input_item_id),
  unique (account_id, caller_id, output_result_id),
  foreign key (account_id, caller_id, input_item_id)
    references public.agent_outbox_input_items(account_id, caller_id, input_item_id)
    on delete cascade,
  foreign key (account_id, caller_id)
    references public.agent_outbox_callers(account_id, caller_id)
);

create index agent_outbox_output_results_ready_idx
  on public.agent_outbox_output_results(account_id, caller_id, answered_at, output_result_id);

create index agent_outbox_output_results_expires_idx
  on public.agent_outbox_output_results(account_id, expires_at);

create table public.agent_outbox_output_files (
  output_file_id uuid primary key default extensions.gen_random_uuid(),
  output_result_id uuid not null references public.agent_outbox_output_results(output_result_id) on delete cascade,
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  caller_id uuid not null references public.agent_outbox_callers(caller_id) on delete cascade,
  display_order integer not null default 0 check (display_order >= 0),
  filename text not null,
  mime_type text,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  file_bytes bytea not null,
  created_at timestamptz not null default now(),
  unique (output_result_id, display_order),
  foreign key (account_id, caller_id, output_result_id)
    references public.agent_outbox_output_results(account_id, caller_id, output_result_id)
    on delete cascade,
  foreign key (account_id, caller_id)
    references public.agent_outbox_callers(account_id, caller_id)
);

create index agent_outbox_output_files_account_idx
  on public.agent_outbox_output_files(account_id, caller_id, output_result_id);

create table public.agent_outbox_audit_events (
  audit_event_id uuid primary key default extensions.gen_random_uuid(),
  event_type text not null,
  occurred_at timestamptz not null default now(),
  account_audit_id uuid not null,
  caller_audit_id uuid,
  input_item_id uuid,
  output_result_id uuid,
  output_file_id uuid,
  item_status text,
  response_kind text,
  non_file_bytes bigint check (non_file_bytes is null or non_file_bytes >= 0),
  file_bytes bigint check (file_bytes is null or file_bytes >= 0),
  quota_metric text,
  limit_name text,
  deletion_reason text,
  request_id text,
  correlation_id text,
  caller_item_id_hash text,
  metadata jsonb not null default '{}'::jsonb
);

create index agent_outbox_audit_events_account_time_idx
  on public.agent_outbox_audit_events(account_audit_id, occurred_at);

create index agent_outbox_audit_events_output_idx
  on public.agent_outbox_audit_events(caller_audit_id, output_result_id, event_type);

create or replace function public.agent_outbox_reject_account_audit_id_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.account_audit_id is distinct from new.account_audit_id then
    raise exception 'agent_outbox_accounts.account_audit_id is immutable'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger agent_outbox_accounts_audit_id_immutable
before update of account_audit_id on public.agent_outbox_accounts
for each row execute function public.agent_outbox_reject_account_audit_id_mutation();

create or replace function public.agent_outbox_reject_caller_audit_id_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.caller_audit_id is distinct from new.caller_audit_id then
    raise exception 'agent_outbox_callers.caller_audit_id is immutable'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger agent_outbox_callers_audit_id_immutable
before update of caller_audit_id on public.agent_outbox_callers
for each row execute function public.agent_outbox_reject_caller_audit_id_mutation();

create table public.agent_outbox_account_quota_windows (
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  metric text not null,
  window_kind text not null check (window_kind in ('minute', 'day', 'calendar_month')),
  window_start_utc timestamptz not null,
  used_units bigint not null default 0 check (used_units >= 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, metric, window_kind, window_start_utc)
);

create table public.agent_outbox_account_limit_blocks (
  account_id uuid not null references public.agent_outbox_accounts(account_id) on delete cascade,
  operation_kind text not null,
  limit_name text not null,
  limit_reason_code text not null,
  limit_reason text not null,
  limit_resets_at timestamptz,
  used_units bigint check (used_units is null or used_units >= 0),
  limit_units bigint check (limit_units is null or limit_units >= 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, operation_kind, limit_name)
);

create index agent_outbox_account_limit_blocks_active_idx
  on public.agent_outbox_account_limit_blocks(account_id, operation_kind, limit_resets_at);

create table public.agent_outbox_cleanup_runs (
  cleanup_run_id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid references public.agent_outbox_accounts(account_id) on delete set null,
  operation_kind text not null,
  status text not null check (status in ('started', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_affected bigint not null default 0 check (rows_affected >= 0),
  error_code text
);

create or replace function public.agent_outbox_reject_audit_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Break-glass is an administrative escape hatch only. The restricted
  -- application role can set the GUC in its own session, so it must never be
  -- able to satisfy this branch even if it somehow gained update/delete on the
  -- ledger; immutability for the app role must not depend solely on grants.
  if current_user <> 'agent_outbox_app'
    and current_setting('agent_outbox.audit_break_glass', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;

    return new;
  end if;

  raise exception 'agent_outbox_audit_events is append-only'
    using errcode = '42501';
end;
$$;

create trigger agent_outbox_audit_events_append_only
before update or delete on public.agent_outbox_audit_events
for each row execute function public.agent_outbox_reject_audit_mutation();

create or replace function public.agent_outbox_output_ack_already_recorded(p_output_result_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.agent_outbox_audit_events e
    join public.agent_outbox_callers c
      on c.caller_audit_id = e.caller_audit_id
    where e.output_result_id = p_output_result_id
      and e.event_type = 'output_acknowledged'
      and c.account_id = public.agent_outbox_context_account_id()
      and public.agent_outbox_context_allows_caller(c.caller_id)
  )
$$;

create or replace function public.agent_outbox_delete_output_result(
  p_output_result_id uuid,
  p_deletion_reason text,
  p_request_id text default null
)
returns table(output_deleted boolean, input_deleted boolean, files_deleted integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  target_output record;
  file_count integer := 0;
begin
  select
    o.output_result_id,
    o.input_item_id,
    o.account_id,
    o.caller_id,
    o.response_kind,
    o.response_payload_bytes,
    o.caller_item_id,
    i.non_file_payload_bytes,
    i.caller_item_id_hash,
    a.account_audit_id,
    c.caller_audit_id
  into target_output
  from public.agent_outbox_output_results o
  join public.agent_outbox_input_items i
    on i.input_item_id = o.input_item_id
  join public.agent_outbox_accounts a
    on a.account_id = o.account_id
  join public.agent_outbox_callers c
    on c.caller_id = o.caller_id
  where o.output_result_id = p_output_result_id
    and o.account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(o.caller_id)
  for update of o, i;

  if not found then
    output_deleted := false;
    input_deleted := false;
    files_deleted := 0;
    return next;
    return;
  end if;

  insert into public.agent_outbox_audit_events (
    event_type,
    account_audit_id,
    caller_audit_id,
    output_result_id,
    output_file_id,
    response_kind,
    file_bytes,
    deletion_reason,
    request_id,
    caller_item_id_hash
  )
  select
    'file_deleted',
    target_output.account_audit_id,
    target_output.caller_audit_id,
    target_output.output_result_id,
    f.output_file_id,
    target_output.response_kind,
    f.size_bytes,
    p_deletion_reason,
    p_request_id,
    target_output.caller_item_id_hash
  from public.agent_outbox_output_files f
  where f.output_result_id = target_output.output_result_id;

  get diagnostics file_count = row_count;

  insert into public.agent_outbox_audit_events (
    event_type,
    account_audit_id,
    caller_audit_id,
    input_item_id,
    output_result_id,
    item_status,
    response_kind,
    non_file_bytes,
    deletion_reason,
    request_id,
    caller_item_id_hash
  )
  values (
    case
      when p_deletion_reason = 'acknowledgement' then 'output_acknowledged'
      else 'output_deleted'
    end,
    target_output.account_audit_id,
    target_output.caller_audit_id,
    target_output.input_item_id,
    target_output.output_result_id,
    'answered',
    target_output.response_kind,
    target_output.non_file_payload_bytes + target_output.response_payload_bytes,
    p_deletion_reason,
    p_request_id,
    target_output.caller_item_id_hash
  );

  delete from public.agent_outbox_output_results
  where output_result_id = target_output.output_result_id;

  delete from public.agent_outbox_input_items
  where input_item_id = target_output.input_item_id;

  output_deleted := true;
  input_deleted := true;
  files_deleted := file_count;
  return next;
end;
$$;

create or replace function public.agent_outbox_restore_unread_output(
  p_output_result_id uuid,
  p_request_id text default null
)
returns table(output_deleted boolean, input_restored boolean, files_deleted integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  target_output record;
  file_count integer := 0;
begin
  select
    o.output_result_id,
    o.input_item_id,
    o.account_id,
    o.caller_id,
    o.response_kind,
    o.response_payload_bytes,
    i.caller_item_id_hash,
    a.account_audit_id,
    c.caller_audit_id
  into target_output
  from public.agent_outbox_output_results o
  join public.agent_outbox_input_items i
    on i.input_item_id = o.input_item_id
  join public.agent_outbox_accounts a
    on a.account_id = o.account_id
  join public.agent_outbox_callers c
    on c.caller_id = o.caller_id
  where o.output_result_id = p_output_result_id
    and o.first_read_at is null
    and o.account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(o.caller_id)
  for update of o, i;

  if not found then
    output_deleted := false;
    input_restored := false;
    files_deleted := 0;
    return next;
    return;
  end if;

  insert into public.agent_outbox_audit_events (
    event_type,
    account_audit_id,
    caller_audit_id,
    output_result_id,
    output_file_id,
    response_kind,
    file_bytes,
    deletion_reason,
    request_id,
    caller_item_id_hash
  )
  select
    'file_deleted',
    target_output.account_audit_id,
    target_output.caller_audit_id,
    target_output.output_result_id,
    f.output_file_id,
    target_output.response_kind,
    f.size_bytes,
    'pre_read_undo',
    p_request_id,
    target_output.caller_item_id_hash
  from public.agent_outbox_output_files f
  where f.output_result_id = target_output.output_result_id;

  get diagnostics file_count = row_count;

  delete from public.agent_outbox_output_results
  where output_result_id = target_output.output_result_id;

  update public.agent_outbox_input_items
  set
    status = 'pending',
    current_revision = current_revision + 1,
    answered_at = null,
    updated_at = now()
  where input_item_id = target_output.input_item_id;

  insert into public.agent_outbox_audit_events (
    event_type,
    account_audit_id,
    caller_audit_id,
    input_item_id,
    output_result_id,
    item_status,
    response_kind,
    non_file_bytes,
    deletion_reason,
    request_id,
    caller_item_id_hash
  )
  values (
    'output_undone',
    target_output.account_audit_id,
    target_output.caller_audit_id,
    target_output.input_item_id,
    target_output.output_result_id,
    'pending',
    target_output.response_kind,
    target_output.response_payload_bytes,
    'pre_read_undo',
    p_request_id,
    target_output.caller_item_id_hash
  );

  output_deleted := true;
  input_restored := true;
  files_deleted := file_count;
  return next;
end;
$$;

create or replace function public.agent_outbox_delete_expired_outputs(
  p_now timestamptz default now()
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  output_id uuid;
  deleted_count integer := 0;
begin
  for output_id in
    select output_result_id
    from public.agent_outbox_output_results
    where account_id = public.agent_outbox_context_account_id()
      and expires_at <= p_now
    order by expires_at, output_result_id
  loop
    perform *
    from public.agent_outbox_delete_output_result(
      output_id,
      'output_timeout',
      null
    );
    deleted_count := deleted_count + 1;
  end loop;

  return deleted_count;
end;
$$;

create or replace function public.agent_outbox_delete_retained_pending_inputs(
  p_retention_before timestamptz,
  p_request_id text default null
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  with pending_targets as (
    select
      i.input_item_id,
      i.non_file_payload_bytes,
      i.caller_item_id_hash,
      a.account_audit_id,
      c.caller_audit_id
    from public.agent_outbox_input_items i
    join public.agent_outbox_accounts a
      on a.account_id = i.account_id
    join public.agent_outbox_callers c
      on c.caller_id = i.caller_id
    where i.account_id = public.agent_outbox_context_account_id()
      and i.status = 'pending'
      and i.updated_at < p_retention_before
  ),
  audit_insert as (
    insert into public.agent_outbox_audit_events (
      event_type,
      account_audit_id,
      caller_audit_id,
      input_item_id,
      item_status,
      deletion_reason,
      non_file_bytes,
      request_id,
      caller_item_id_hash
    )
    select
      'input_deleted',
      account_audit_id,
      caller_audit_id,
      input_item_id,
      'pending',
      'input_retention',
      non_file_payload_bytes,
      p_request_id,
      caller_item_id_hash
    from pending_targets
  )
  delete from public.agent_outbox_input_items i
  using pending_targets t
  where i.input_item_id = t.input_item_id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.agent_outbox_cleanup_downgrade_grace_expiry(
  p_non_file_payload_limit_bytes bigint,
  p_now timestamptz default now()
)
returns table(expired_outputs_deleted integer, file_outputs_deleted integer, file_inputs_deleted integer, oldest_inputs_deleted integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  output_id uuid;
  input_id uuid;
  target_output_id uuid;
  input_status text;
  current_non_file_bytes bigint;
  input_total_bytes bigint;
  deleted_rows integer;
begin
  expired_outputs_deleted := public.agent_outbox_delete_expired_outputs(p_now);
  file_outputs_deleted := 0;
  file_inputs_deleted := 0;
  oldest_inputs_deleted := 0;

  for output_id in
    select o.output_result_id
    from public.agent_outbox_output_results o
    where o.account_id = public.agent_outbox_context_account_id()
      and exists (
        select 1
        from public.agent_outbox_output_files f
        where f.output_result_id = o.output_result_id
      )
    order by o.answered_at, o.output_result_id
  loop
    perform *
    from public.agent_outbox_delete_output_result(
      output_id,
      'downgrade_grace_file_output',
      null
    );
    file_outputs_deleted := file_outputs_deleted + 1;
  end loop;

  with file_input_targets as (
    select
      i.input_item_id,
      i.non_file_payload_bytes,
      i.caller_item_id_hash,
      i.status,
      a.account_audit_id,
      c.caller_audit_id
    from public.agent_outbox_input_items i
    join public.agent_outbox_accounts a
      on a.account_id = i.account_id
    join public.agent_outbox_callers c
      on c.caller_id = i.caller_id
    where i.account_id = public.agent_outbox_context_account_id()
      and i.status = 'pending'
      and exists (
        select 1
        from public.agent_outbox_input_actions action
        where action.input_item_id = i.input_item_id
          and action.popup_kind = 'file_upload'
      )
  ),
  audit_insert as (
    insert into public.agent_outbox_audit_events (
      event_type,
      account_audit_id,
      caller_audit_id,
      input_item_id,
      item_status,
      deletion_reason,
      non_file_bytes,
      caller_item_id_hash
    )
    select
      'input_deleted',
      account_audit_id,
      caller_audit_id,
      input_item_id,
      status,
      'downgrade_grace_file_input',
      non_file_payload_bytes,
      caller_item_id_hash
    from file_input_targets
  )
  delete from public.agent_outbox_input_items i
  using file_input_targets t
  where i.input_item_id = t.input_item_id;

  get diagnostics file_inputs_deleted = row_count;

  select coalesce(sum(non_file_payload_bytes), 0)
    + coalesce((
      select sum(response_payload_bytes)
      from public.agent_outbox_output_results
      where account_id = public.agent_outbox_context_account_id()
    ), 0)
  into current_non_file_bytes
  from public.agent_outbox_input_items
  where account_id = public.agent_outbox_context_account_id();

  for input_id, input_status, target_output_id, input_total_bytes in
    select
      i.input_item_id,
      i.status,
      o.output_result_id,
      i.non_file_payload_bytes + coalesce(o.response_payload_bytes, 0)
    from public.agent_outbox_input_items i
    left join public.agent_outbox_output_results o
      on o.input_item_id = i.input_item_id
    where i.account_id = public.agent_outbox_context_account_id()
    order by coalesce(i.answered_at, i.updated_at), i.input_item_id
  loop
    exit when current_non_file_bytes <= p_non_file_payload_limit_bytes;

    if input_status = 'answered' and target_output_id is not null then
      select case when od.output_deleted then 1 else 0 end
        into deleted_rows
      from public.agent_outbox_delete_output_result(
        target_output_id,
        'downgrade_grace_non_file_payload_limit',
        null
      ) od;
      deleted_rows := coalesce(deleted_rows, 0);
    else
      insert into public.agent_outbox_audit_events (
        event_type,
        account_audit_id,
        caller_audit_id,
        input_item_id,
        item_status,
        deletion_reason,
        non_file_bytes,
        caller_item_id_hash
      )
      select
        'input_deleted',
        a.account_audit_id,
        c.caller_audit_id,
        i.input_item_id,
        i.status,
        'downgrade_grace_non_file_payload_limit',
        i.non_file_payload_bytes,
        i.caller_item_id_hash
      from public.agent_outbox_input_items i
      join public.agent_outbox_accounts a
        on a.account_id = i.account_id
      join public.agent_outbox_callers c
        on c.caller_id = i.caller_id
      where i.input_item_id = input_id;

      delete from public.agent_outbox_input_items
      where input_item_id = input_id;
      get diagnostics deleted_rows = row_count;
    end if;

    if deleted_rows > 0 then
      current_non_file_bytes :=
        current_non_file_bytes - coalesce(input_total_bytes, 0);
      oldest_inputs_deleted := oldest_inputs_deleted + 1;
    end if;
  end loop;

  return next;
end;
$$;

create or replace function public.agent_outbox_prune_quota_windows(
  p_before timestamptz
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.agent_outbox_account_quota_windows
  where account_id = public.agent_outbox_context_account_id()
    and updated_at < p_before;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.agent_outbox_prune_expired_limit_blocks(
  p_now timestamptz default now()
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.agent_outbox_account_limit_blocks
  where account_id = public.agent_outbox_context_account_id()
    and limit_resets_at is not null
    and limit_resets_at <= p_now;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

alter table public.agent_outbox_accounts enable row level security;
alter table public.agent_outbox_users enable row level security;
alter table public.agent_outbox_account_members enable row level security;
alter table public.agent_outbox_callers enable row level security;
alter table public.agent_outbox_caller_credentials enable row level security;
alter table public.agent_outbox_input_items enable row level security;
alter table public.agent_outbox_input_link_buttons enable row level security;
alter table public.agent_outbox_input_actions enable row level security;
alter table public.agent_outbox_input_action_popup_options enable row level security;
alter table public.agent_outbox_output_results enable row level security;
alter table public.agent_outbox_output_files enable row level security;
alter table public.agent_outbox_audit_events enable row level security;
alter table public.agent_outbox_account_quota_windows enable row level security;
alter table public.agent_outbox_account_limit_blocks enable row level security;
alter table public.agent_outbox_cleanup_runs enable row level security;

alter table public.agent_outbox_accounts force row level security;
alter table public.agent_outbox_users force row level security;
alter table public.agent_outbox_account_members force row level security;
alter table public.agent_outbox_callers force row level security;
alter table public.agent_outbox_caller_credentials force row level security;
alter table public.agent_outbox_input_items force row level security;
alter table public.agent_outbox_input_link_buttons force row level security;
alter table public.agent_outbox_input_actions force row level security;
alter table public.agent_outbox_input_action_popup_options force row level security;
alter table public.agent_outbox_output_results force row level security;
alter table public.agent_outbox_output_files force row level security;
alter table public.agent_outbox_audit_events force row level security;
alter table public.agent_outbox_account_quota_windows force row level security;
alter table public.agent_outbox_account_limit_blocks force row level security;
alter table public.agent_outbox_cleanup_runs force row level security;

create policy agent_outbox_accounts_account_context
  on public.agent_outbox_accounts
  for all
  using (public.agent_outbox_context_allows_account(account_id))
  with check (public.agent_outbox_context_allows_account(account_id));

create policy agent_outbox_users_user_context
  on public.agent_outbox_users
  for all
  using (user_id = public.agent_outbox_context_user_id())
  with check (user_id = public.agent_outbox_context_user_id());

create policy agent_outbox_account_members_account_context
  on public.agent_outbox_account_members
  for all
  using (public.agent_outbox_context_allows_account(account_id))
  with check (public.agent_outbox_context_allows_account(account_id));

create policy agent_outbox_callers_account_context
  on public.agent_outbox_callers
  for all
  using (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  )
  with check (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  );

create policy agent_outbox_caller_credentials_account_context
  on public.agent_outbox_caller_credentials
  for all
  using (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  )
  with check (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  );

create policy agent_outbox_input_items_account_context
  on public.agent_outbox_input_items
  for all
  using (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  )
  with check (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  );

create policy agent_outbox_input_link_buttons_parent_context
  on public.agent_outbox_input_link_buttons
  for all
  using (
    exists (
      select 1
      from public.agent_outbox_input_items i
      where i.input_item_id = agent_outbox_input_link_buttons.input_item_id
        and i.account_id = public.agent_outbox_context_account_id()
        and public.agent_outbox_context_allows_caller(i.caller_id)
    )
  )
  with check (
    exists (
      select 1
      from public.agent_outbox_input_items i
      where i.input_item_id = agent_outbox_input_link_buttons.input_item_id
        and i.account_id = public.agent_outbox_context_account_id()
        and public.agent_outbox_context_allows_caller(i.caller_id)
    )
  );

create policy agent_outbox_input_actions_parent_context
  on public.agent_outbox_input_actions
  for all
  using (
    exists (
      select 1
      from public.agent_outbox_input_items i
      where i.input_item_id = agent_outbox_input_actions.input_item_id
        and i.account_id = public.agent_outbox_context_account_id()
        and public.agent_outbox_context_allows_caller(i.caller_id)
    )
  )
  with check (
    exists (
      select 1
      from public.agent_outbox_input_items i
      where i.input_item_id = agent_outbox_input_actions.input_item_id
        and i.account_id = public.agent_outbox_context_account_id()
        and public.agent_outbox_context_allows_caller(i.caller_id)
    )
  );

create policy agent_outbox_input_action_popup_options_parent_context
  on public.agent_outbox_input_action_popup_options
  for all
  using (
    exists (
      select 1
      from public.agent_outbox_input_actions action
      join public.agent_outbox_input_items i
        on i.input_item_id = action.input_item_id
      where action.input_action_id = agent_outbox_input_action_popup_options.input_action_id
        and i.account_id = public.agent_outbox_context_account_id()
        and public.agent_outbox_context_allows_caller(i.caller_id)
    )
  )
  with check (
    exists (
      select 1
      from public.agent_outbox_input_actions action
      join public.agent_outbox_input_items i
        on i.input_item_id = action.input_item_id
      where action.input_action_id = agent_outbox_input_action_popup_options.input_action_id
        and i.account_id = public.agent_outbox_context_account_id()
        and public.agent_outbox_context_allows_caller(i.caller_id)
    )
  );

create policy agent_outbox_output_results_account_context
  on public.agent_outbox_output_results
  for all
  using (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  )
  with check (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  );

create policy agent_outbox_output_files_account_context
  on public.agent_outbox_output_files
  for all
  using (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  )
  with check (
    account_id = public.agent_outbox_context_account_id()
    and public.agent_outbox_context_allows_caller(caller_id)
  );

create policy agent_outbox_audit_events_insert
  on public.agent_outbox_audit_events
  for insert
  with check (
    exists (
      select 1
      from public.agent_outbox_accounts a
      where a.account_id = public.agent_outbox_context_account_id()
        and a.account_audit_id = agent_outbox_audit_events.account_audit_id
        and public.agent_outbox_context_allows_caller_audit_id(
          agent_outbox_audit_events.caller_audit_id
        )
    )
  );

create policy agent_outbox_audit_events_select
  on public.agent_outbox_audit_events
  for select
  using (
    exists (
      select 1
      from public.agent_outbox_accounts a
      where a.account_id = public.agent_outbox_context_account_id()
        and a.account_audit_id = agent_outbox_audit_events.account_audit_id
        and public.agent_outbox_context_allows_caller_audit_id(
          agent_outbox_audit_events.caller_audit_id
        )
    )
  );

create policy agent_outbox_quota_windows_account_context
  on public.agent_outbox_account_quota_windows
  for all
  using (public.agent_outbox_context_allows_account(account_id))
  with check (public.agent_outbox_context_allows_account(account_id));

create policy agent_outbox_limit_blocks_account_context
  on public.agent_outbox_account_limit_blocks
  for all
  using (public.agent_outbox_context_allows_account(account_id))
  with check (public.agent_outbox_context_allows_account(account_id));

create policy agent_outbox_cleanup_runs_account_context
  on public.agent_outbox_cleanup_runs
  for all
  using (
    (
      account_id is null
      and public.agent_outbox_context_auth_surface() = 'cleanup'
    )
    or public.agent_outbox_context_allows_account(account_id)
  )
  with check (
    (
      account_id is null
      and public.agent_outbox_context_auth_surface() = 'cleanup'
    )
    or public.agent_outbox_context_allows_account(account_id)
  );

revoke execute on function public.agent_outbox_context_account_id() from public;
revoke execute on function public.agent_outbox_context_user_id() from public;
revoke execute on function public.agent_outbox_context_caller_id() from public;
revoke execute on function public.agent_outbox_context_auth_surface() from public;
revoke execute on function public.agent_outbox_context_has_account_membership() from public;
revoke execute on function public.agent_outbox_context_allows_account(uuid) from public;
revoke execute on function public.agent_outbox_context_allows_caller(uuid) from public;
revoke execute on function public.agent_outbox_context_allows_caller_audit_id(uuid) from public;
revoke execute on function public.agent_outbox_lookup_caller_credential(text) from public;
revoke execute on function public.agent_outbox_reject_account_audit_id_mutation() from public;
revoke execute on function public.agent_outbox_reject_caller_audit_id_mutation() from public;
revoke execute on function public.agent_outbox_reject_audit_mutation() from public;
revoke execute on function public.agent_outbox_output_ack_already_recorded(uuid) from public;
revoke execute on function public.agent_outbox_delete_output_result(uuid, text, text) from public;
revoke execute on function public.agent_outbox_restore_unread_output(uuid, text) from public;
revoke execute on function public.agent_outbox_delete_expired_outputs(timestamptz) from public;
revoke execute on function public.agent_outbox_delete_retained_pending_inputs(timestamptz, text) from public;
revoke execute on function public.agent_outbox_cleanup_downgrade_grace_expiry(bigint, timestamptz) from public;
revoke execute on function public.agent_outbox_prune_quota_windows(timestamptz) from public;
revoke execute on function public.agent_outbox_prune_expired_limit_blocks(timestamptz) from public;

grant execute on function public.agent_outbox_context_account_id() to agent_outbox_app;
grant execute on function public.agent_outbox_context_user_id() to agent_outbox_app;
grant execute on function public.agent_outbox_context_caller_id() to agent_outbox_app;
grant execute on function public.agent_outbox_context_auth_surface() to agent_outbox_app;
grant execute on function public.agent_outbox_context_has_account_membership() to agent_outbox_app;
grant execute on function public.agent_outbox_context_allows_account(uuid) to agent_outbox_app;
grant execute on function public.agent_outbox_context_allows_caller(uuid) to agent_outbox_app;
grant execute on function public.agent_outbox_context_allows_caller_audit_id(uuid) to agent_outbox_app;
grant execute on function public.agent_outbox_lookup_caller_credential(text) to agent_outbox_app;
grant execute on function public.agent_outbox_reject_account_audit_id_mutation() to agent_outbox_app;
grant execute on function public.agent_outbox_reject_caller_audit_id_mutation() to agent_outbox_app;
grant execute on function public.agent_outbox_reject_audit_mutation() to agent_outbox_app;
grant execute on function public.agent_outbox_output_ack_already_recorded(uuid) to agent_outbox_app;
grant execute on function public.agent_outbox_delete_output_result(uuid, text, text) to agent_outbox_app;
grant execute on function public.agent_outbox_restore_unread_output(uuid, text) to agent_outbox_app;
grant execute on function public.agent_outbox_delete_expired_outputs(timestamptz) to agent_outbox_app;
grant execute on function public.agent_outbox_delete_retained_pending_inputs(timestamptz, text) to agent_outbox_app;
grant execute on function public.agent_outbox_cleanup_downgrade_grace_expiry(bigint, timestamptz) to agent_outbox_app;
grant execute on function public.agent_outbox_prune_quota_windows(timestamptz) to agent_outbox_app;
grant execute on function public.agent_outbox_prune_expired_limit_blocks(timestamptz) to agent_outbox_app;

-- Some hosted Postgres providers pre-create API roles and grant them access via
-- default privileges. Revoke those roles when present without making the schema
-- depend on any one provider.
revoke all on
  public.agent_outbox_accounts,
  public.agent_outbox_users,
  public.agent_outbox_account_members,
  public.agent_outbox_callers,
  public.agent_outbox_caller_credentials,
  public.agent_outbox_input_items,
  public.agent_outbox_input_link_buttons,
  public.agent_outbox_input_actions,
  public.agent_outbox_input_action_popup_options,
  public.agent_outbox_output_results,
  public.agent_outbox_output_files,
  public.agent_outbox_audit_events,
  public.agent_outbox_account_quota_windows,
  public.agent_outbox_account_limit_blocks,
  public.agent_outbox_cleanup_runs
from public;

do $$
declare
  provider_role text;
  app_functions constant text := '
    public.agent_outbox_context_account_id(),
    public.agent_outbox_context_user_id(),
    public.agent_outbox_context_caller_id(),
    public.agent_outbox_context_auth_surface(),
    public.agent_outbox_context_has_account_membership(),
    public.agent_outbox_context_allows_account(uuid),
    public.agent_outbox_context_allows_caller(uuid),
    public.agent_outbox_context_allows_caller_audit_id(uuid),
    public.agent_outbox_lookup_caller_credential(text),
    public.agent_outbox_reject_account_audit_id_mutation(),
    public.agent_outbox_reject_caller_audit_id_mutation(),
    public.agent_outbox_reject_audit_mutation(),
    public.agent_outbox_output_ack_already_recorded(uuid),
    public.agent_outbox_delete_output_result(uuid, text, text),
    public.agent_outbox_restore_unread_output(uuid, text),
    public.agent_outbox_delete_expired_outputs(timestamptz),
    public.agent_outbox_delete_retained_pending_inputs(timestamptz, text),
    public.agent_outbox_cleanup_downgrade_grace_expiry(bigint, timestamptz),
    public.agent_outbox_prune_quota_windows(timestamptz),
    public.agent_outbox_prune_expired_limit_blocks(timestamptz)
  ';
  app_tables constant text := '
    public.agent_outbox_accounts,
    public.agent_outbox_users,
    public.agent_outbox_account_members,
    public.agent_outbox_callers,
    public.agent_outbox_caller_credentials,
    public.agent_outbox_input_items,
    public.agent_outbox_input_link_buttons,
    public.agent_outbox_input_actions,
    public.agent_outbox_input_action_popup_options,
    public.agent_outbox_output_results,
    public.agent_outbox_output_files,
    public.agent_outbox_audit_events,
    public.agent_outbox_account_quota_windows,
    public.agent_outbox_account_limit_blocks,
    public.agent_outbox_cleanup_runs
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
  public.agent_outbox_accounts,
  public.agent_outbox_users,
  public.agent_outbox_account_members,
  public.agent_outbox_callers,
  public.agent_outbox_caller_credentials,
  public.agent_outbox_input_items,
  public.agent_outbox_input_link_buttons,
  public.agent_outbox_input_actions,
  public.agent_outbox_input_action_popup_options,
  public.agent_outbox_output_results,
  public.agent_outbox_output_files,
  public.agent_outbox_account_quota_windows,
  public.agent_outbox_account_limit_blocks,
  public.agent_outbox_cleanup_runs
to agent_outbox_app;

grant select, insert on public.agent_outbox_audit_events to agent_outbox_app;

comment on table public.agent_outbox_audit_events is
  'Append-only content-safe lifecycle and byte-accounting ledger. Does not cascade from live account/caller rows.';

comment on table public.agent_outbox_account_limit_blocks is
  'Derived active denial cache populated from the canonical server limits structure; SQL fields are generic and not an independent limit catalog.';
