alter table public.agent_outbox_output_files
  add constraint agent_outbox_output_files_size_matches_bytes
  check (size_bytes = octet_length(file_bytes)) not valid;

alter table public.agent_outbox_output_files
  validate constraint agent_outbox_output_files_size_matches_bytes;
