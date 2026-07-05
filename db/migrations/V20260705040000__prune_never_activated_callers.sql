create or replace function public.agent_outbox_prune_never_activated_callers(
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
  if public.agent_outbox_context_auth_surface() is distinct from 'cleanup'
    or public.agent_outbox_context_account_id() is null then
    raise exception 'agent_outbox_prune_never_activated_callers forbidden'
      using errcode = '42501';
  end if;

  delete from public.agent_outbox_callers caller
  where caller.account_id = public.agent_outbox_context_account_id()
    and caller.created_at < p_before
    and not exists (
      select 1
      from public.agent_outbox_caller_credentials credential
      where credential.caller_id = caller.caller_id
        and (
          credential.activated_at is not null
          or credential.status in ('active', 'revoked')
          or credential.revoked_at is not null
        )
    )
    and not exists (
      select 1
      from public.agent_outbox_audit_events event
      where event.caller_audit_id = caller.caller_audit_id
    )
    and not exists (
      select 1
      from public.agent_outbox_input_items input
      where input.caller_id = caller.caller_id
    )
    and not exists (
      select 1
      from public.agent_outbox_output_results output
      where output.caller_id = caller.caller_id
    );

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke execute on function public.agent_outbox_prune_never_activated_callers(timestamptz) from public;
grant execute on function public.agent_outbox_prune_never_activated_callers(timestamptz) to agent_outbox_app;

do $$
  declare
    provider_role text;
    app_functions constant text := '
    public.agent_outbox_prune_never_activated_callers(timestamptz)
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
    end if;
  end loop;
end
$$;

comment on function public.agent_outbox_prune_never_activated_callers(timestamptz) is
  'Deletes account-scoped callers that never activated credentials and have no audit, input, or output history after the caller setup cleanup window.';
