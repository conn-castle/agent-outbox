alter table public.agent_outbox_output_results
  add column previous_input_updated_at timestamptz;

comment on column public.agent_outbox_output_results.previous_input_updated_at is
  'Input item updated_at captured before answer creation so pre-read undo restores queue order.';

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
    o.previous_input_updated_at,
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
    and public.agent_outbox_context_auth_surface() = 'human'
    and public.agent_outbox_context_has_account_membership()
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
    updated_at = coalesce(target_output.previous_input_updated_at, now())
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
