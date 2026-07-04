do $$
begin
  if exists (
    select 1
    from public.agent_outbox_output_files
    group by output_result_id
    having count(*) > 1
  ) then
    raise exception 'agent_outbox_output_files already contains multiple rows for one output_result_id'
      using errcode = '23505';
  end if;
end;
$$;

alter table public.agent_outbox_output_files
  add constraint agent_outbox_output_files_one_row_per_result
  unique (output_result_id);
