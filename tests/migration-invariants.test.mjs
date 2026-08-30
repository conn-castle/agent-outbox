import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const initialMigration = readFileSync(
  new URL(
    "../db/migrations/V20260630000000__initial_schema.sql",
    import.meta.url
  ),
  "utf8"
);

const outputFileSizeInvariantMigration = readFileSync(
  new URL(
    "../db/migrations/V20260703223000__output_file_size_invariant.sql",
    import.meta.url
  ),
  "utf8"
);

const scheduledCleanupAccountTargetsMigration = readFileSync(
  new URL(
    "../db/migrations/V20260704123745__scheduled_cleanup_account_targets.sql",
    import.meta.url
  ),
  "utf8"
);

const outputFileSingleRowInvariantMigration = readFileSync(
  new URL(
    "../db/migrations/V20260704123815__output_file_single_row_invariant.sql",
    import.meta.url
  ),
  "utf8"
);

const outputOperationAuthMatrixMigration = readFileSync(
  new URL(
    "../db/migrations/V20260704123900__output_operation_auth_matrix.sql",
    import.meta.url
  ),
  "utf8"
);

const neverActivatedCallerPruneMigration = readFileSync(
  new URL(
    "../db/migrations/V20260705040000__prune_never_activated_callers.sql",
    import.meta.url
  ),
  "utf8"
);

const failClosedFunctionAuthGuardsMigration = readFileSync(
  new URL(
    "../db/migrations/V20260812155500__fail_closed_function_auth_guards.sql",
    import.meta.url
  ),
  "utf8"
);

const phase3ProductTables = [
  "agent_outbox_accounts",
  "agent_outbox_users",
  "agent_outbox_account_members",
  "agent_outbox_callers",
  "agent_outbox_caller_credentials",
  "agent_outbox_input_items",
  "agent_outbox_input_link_buttons",
  "agent_outbox_input_actions",
  "agent_outbox_input_action_popup_options",
  "agent_outbox_output_results",
  "agent_outbox_output_files",
  "agent_outbox_audit_events",
  "agent_outbox_account_quota_windows",
  "agent_outbox_account_limit_blocks",
  "agent_outbox_cleanup_runs"
];

test("phase 3 product tables have row level security enabled and forced", () => {
  for (const table of phase3ProductTables) {
    assert.match(
      initialMigration,
      new RegExp(`alter table public\\.${table} enable row level security;`),
      `${table} must enable row level security`
    );
    assert.match(
      initialMigration,
      new RegExp(`alter table public\\.${table} force row level security;`),
      `${table} must force row level security`
    );
  }
});
test("phase 3 migration keeps audit events append-only for the app role", () => {
  const auditGrantStatements = initialMigration
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => {
      return (
        statement.startsWith("grant ") &&
        statement.includes("agent_outbox_audit_events") &&
        statement.includes("agent_outbox_app")
      );
    });

  assert.match(
    initialMigration,
    /create trigger agent_outbox_audit_events_append_only/
  );
  assert.deepEqual(auditGrantStatements, [
    "grant select, insert on public.agent_outbox_audit_events to agent_outbox_app"
  ]);
});
test("phase 3 migration uses canonical sources for usage and limit state", () => {
  assert.doesNotMatch(initialMigration, /agent_outbox_account_current_usage/);
  assert.doesNotMatch(initialMigration, /agent_outbox_usage_rollups_daily/);
  assert.match(initialMigration, /limit_name text not null/);
  assert.match(initialMigration, /limit_reason_code text not null/);
  assert.doesNotMatch(initialMigration, /limit_name text not null\s+check/is);
});
test("phase 3 migration defines account-scoped cleanup primitives", () => {
  for (const functionName of [
    "agent_outbox_delete_output_result",
    "agent_outbox_restore_unread_output",
    "agent_outbox_delete_expired_outputs",
    "agent_outbox_delete_retained_pending_inputs",
    "agent_outbox_cleanup_downgrade_grace_expiry",
    "agent_outbox_prune_quota_windows",
    "agent_outbox_prune_expired_limit_blocks",
    "agent_outbox_output_ack_already_recorded"
  ]) {
    assert.match(
      initialMigration,
      new RegExp(`create or replace function public\\.${functionName}\\(`),
      `${functionName} must exist`
    );
  }

  assert.match(initialMigration, /'output_acknowledged'/);
  assert.match(initialMigration, /'output_timeout'/);
  assert.match(initialMigration, /'input_retention'/);
  assert.match(initialMigration, /'downgrade_grace_file_output'/);
  assert.match(initialMigration, /'downgrade_grace_non_file_payload_limit'/);
  assert.match(
    initialMigration,
    /if input_status = 'answered' and target_output_id is not null then/
  );
  assert.match(
    initialMigration,
    /from public\.agent_outbox_delete_output_result\(\s*target_output_id,\s*'downgrade_grace_non_file_payload_limit'/s
  );
  assert.match(
    initialMigration,
    /if p_non_file_payload_limit_bytes is null or p_non_file_payload_limit_bytes < 0 then[\s\S]*non_file_payload_limit_bytes must be non-negative/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_delete_expired_outputs[\s\S]*for update skip locked[\s\S]*create or replace function public\.agent_outbox_delete_retained_pending_inputs/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_delete_retained_pending_inputs[\s\S]*for update of i skip locked[\s\S]*create or replace function public\.agent_outbox_cleanup_downgrade_grace_expiry/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_cleanup_downgrade_grace_expiry[\s\S]*for update of o skip locked[\s\S]*with file_input_targets/
  );
  assert.match(
    initialMigration,
    /with file_input_targets as \([\s\S]*for update of i skip locked/
  );
});
test("output operation auth migration narrows destructive SQL functions", () => {
  assert.match(
    outputOperationAuthMatrixMigration,
    /create or replace function public\.agent_outbox_delete_output_result\(\s*p_output_result_id uuid,\s*p_deletion_reason text,\s*p_request_id text default null\s*\)/s
  );
  assert.match(
    outputOperationAuthMatrixMigration,
    /p_deletion_reason = 'acknowledgement'[\s\S]*public\.agent_outbox_context_auth_surface\(\) = 'caller'[\s\S]*o\.caller_id = public\.agent_outbox_context_caller_id\(\)/s
  );
  assert.match(
    outputOperationAuthMatrixMigration,
    /p_deletion_reason in \([\s\S]*'output_timeout'[\s\S]*'downgrade_grace_file_output'[\s\S]*'downgrade_grace_non_file_payload_limit'[\s\S]*public\.agent_outbox_context_auth_surface\(\) = 'cleanup'/s
  );
  assert.match(
    outputOperationAuthMatrixMigration,
    /create or replace function public\.agent_outbox_restore_unread_output\(\s*p_output_result_id uuid,\s*p_request_id text default null\s*\)[\s\S]*public\.agent_outbox_context_auth_surface\(\) = 'human'[\s\S]*public\.agent_outbox_context_has_account_membership\(\)/s
  );
  assert.doesNotMatch(
    outputOperationAuthMatrixMigration,
    /agent_outbox_context_allows_caller\(o\.caller_id\)/
  );
});
test("phase 3 migration keeps representative policies tied to transaction context", () => {
  assert.match(initialMigration, /agent_outbox_context_account_id\(\)/);
  assert.match(initialMigration, /agent_outbox_context_caller_id\(\)/);
  assert.match(initialMigration, /agent_outbox_context_user_id\(\)/);
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_context_allows_caller\(p_caller_id uuid\)/
  );
  assert.match(
    initialMigration,
    /when 'caller' then\s+public\.agent_outbox_context_caller_id\(\) is not null\s+and p_caller_id = public\.agent_outbox_context_caller_id\(\)/s
  );
  assert.doesNotMatch(
    initialMigration,
    /agent_outbox_context_caller_id\(\) is null/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_context_has_account_membership\(\)/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_context_allows_account\(p_account_id uuid\)/
  );
  assert.match(
    initialMigration,
    /when 'human' then public\.agent_outbox_context_has_account_membership\(\)/
  );
  assert.doesNotMatch(initialMigration, /when 'human' then true/);
  assert.match(
    initialMigration,
    /create policy agent_outbox_input_items_account_context/
  );
  assert.match(
    initialMigration,
    /create policy agent_outbox_output_results_account_context/
  );
  assert.match(
    initialMigration,
    /create policy agent_outbox_callers_account_context/
  );
});
test("phase 3 migration keeps output and file ownership tied to parents", () => {
  assert.match(
    initialMigration,
    /unique \(account_id, caller_id, input_item_id\)/
  );
  assert.match(
    initialMigration,
    /foreign key \(account_id, caller_id, input_item_id\)\s+references public\.agent_outbox_input_items\(account_id, caller_id, input_item_id\)/s
  );
  assert.match(
    initialMigration,
    /unique \(account_id, caller_id, output_result_id\)/
  );
  assert.match(
    initialMigration,
    /foreign key \(account_id, caller_id, output_result_id\)\s+references public\.agent_outbox_output_results\(account_id, caller_id, output_result_id\)/s
  );
  assert.match(
    outputFileSizeInvariantMigration,
    /constraint agent_outbox_output_files_size_matches_bytes/
  );
  assert.match(
    outputFileSizeInvariantMigration,
    /check \(size_bytes = octet_length\(file_bytes\)\) not valid/
  );
  assert.match(
    outputFileSizeInvariantMigration,
    /validate constraint agent_outbox_output_files_size_matches_bytes/
  );
  assert.match(outputFileSingleRowInvariantMigration, /having count\(\*\) > 1/);
  assert.match(
    outputFileSingleRowInvariantMigration,
    /raise exception 'agent_outbox_output_files already contains multiple rows for one output_result_id'/
  );
  assert.match(
    outputFileSingleRowInvariantMigration,
    /constraint agent_outbox_output_files_one_row_per_result\s+unique \(output_result_id\)/s
  );
});
test("scheduled cleanup account targets are cleanup-surface only", () => {
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /create or replace function public\.agent_outbox_cleanup_account_targets\(\)/
  );
  assert.match(scheduledCleanupAccountTargetsMigration, /security definer/);
  assert.match(
    failClosedFunctionAuthGuardsMigration,
    /agent_outbox_context_auth_surface\(\) is distinct from 'cleanup'/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /raise exception 'agent_outbox_cleanup_account_targets forbidden'/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /select account\.account_id, account\.tier[\s\S]*from public\.agent_outbox_accounts account/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /revoke execute on function public\.agent_outbox_cleanup_account_targets\(\) from public;/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /grant execute on function public\.agent_outbox_cleanup_account_targets\(\) to agent_outbox_app;/
  );
});
test("function auth guards fail closed when transaction context is unset", () => {
  for (const functionName of [
    "agent_outbox_bootstrap_clerk_human",
    "agent_outbox_prune_ip_quota_windows",
    "agent_outbox_prune_caller_setup_requests",
    "agent_outbox_cleanup_account_targets",
    "agent_outbox_prune_stripe_webhook_events"
  ]) {
    assert.match(
      failClosedFunctionAuthGuardsMigration,
      new RegExp(
        `create or replace function public\\.${functionName}\\([\\s\\S]*?agent_outbox_context_auth_surface\\(\\) is distinct from`,
        "i"
      )
    );
  }
});
test("never-activated caller prune migration is cleanup-scoped and preserves history", () => {
  assert.match(
    neverActivatedCallerPruneMigration,
    /create or replace function public\.agent_outbox_prune_never_activated_callers\(\s*p_before timestamptz\s*\)/s
  );
  assert.match(neverActivatedCallerPruneMigration, /security definer/);
  assert.match(
    neverActivatedCallerPruneMigration,
    /set search_path = public, pg_temp/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /agent_outbox_context_auth_surface\(\) is distinct from 'cleanup'[\s\S]*agent_outbox_context_account_id\(\) is null/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /raise exception 'agent_outbox_prune_never_activated_callers forbidden'/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /delete from public\.agent_outbox_callers caller/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /caller\.account_id = public\.agent_outbox_context_account_id\(\)/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /credential\.activated_at is not null[\s\S]*credential\.status in \('active', 'revoked'\)[\s\S]*credential\.revoked_at is not null/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /event\.caller_audit_id = caller\.caller_audit_id/
  );
  assert.doesNotMatch(neverActivatedCallerPruneMigration, /event\.caller_id/);
  assert.match(
    neverActivatedCallerPruneMigration,
    /from public\.agent_outbox_input_items input[\s\S]*input\.caller_id = caller\.caller_id/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /from public\.agent_outbox_output_results output[\s\S]*output\.caller_id = caller\.caller_id/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /revoke execute on function public\.agent_outbox_prune_never_activated_callers\(timestamptz\) from public;/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /grant execute on function public\.agent_outbox_prune_never_activated_callers\(timestamptz\) to agent_outbox_app;/
  );
  assert.match(neverActivatedCallerPruneMigration, /'anon'/);
  assert.match(neverActivatedCallerPruneMigration, /'authenticated'/);
  assert.match(neverActivatedCallerPruneMigration, /'service_role'/);
});
test("phase 3 migration restricts app function execution to the app role", () => {
  for (const functionSignature of [
    "agent_outbox_context_account_id()",
    "agent_outbox_context_user_id()",
    "agent_outbox_context_caller_id()",
    "agent_outbox_context_auth_surface()",
    "agent_outbox_context_has_account_membership()",
    "agent_outbox_context_allows_account(uuid)",
    "agent_outbox_context_allows_caller(uuid)",
    "agent_outbox_context_allows_caller_audit_id(uuid)",
    "agent_outbox_lookup_caller_credential(text)",
    "agent_outbox_reject_account_audit_id_mutation()",
    "agent_outbox_reject_caller_audit_id_mutation()",
    "agent_outbox_reject_audit_mutation()",
    "agent_outbox_output_ack_already_recorded(uuid)",
    "agent_outbox_delete_output_result(uuid, text, text)",
    "agent_outbox_restore_unread_output(uuid, text)",
    "agent_outbox_delete_expired_outputs(timestamptz)",
    "agent_outbox_delete_retained_pending_inputs(timestamptz, text)",
    "agent_outbox_cleanup_downgrade_grace_expiry(bigint, timestamptz)",
    "agent_outbox_prune_quota_windows(timestamptz)",
    "agent_outbox_prune_expired_limit_blocks(timestamptz)"
  ]) {
    const escapedSignature = functionSignature.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    assert.match(
      initialMigration,
      new RegExp(
        `revoke execute on function public\\.${escapedSignature} from public;`
      )
    );
    assert.match(
      initialMigration,
      new RegExp(
        `grant execute on function public\\.${escapedSignature} to agent_outbox_app;`
      )
    );
  }
  assert.match(initialMigration, /foreach provider_role in array array/);
  assert.match(initialMigration, /'anon'/);
  assert.match(initialMigration, /'authenticated'/);
  assert.match(initialMigration, /'service_role'/);
});
test("initial migration keeps the app role restricted before schema access", () => {
  assert.match(initialMigration, /create role agent_outbox_app/);
  assert.match(initialMigration, /nosuperuser/);
  assert.match(initialMigration, /nocreatedb/);
  assert.match(initialMigration, /nocreaterole/);
  assert.match(initialMigration, /noreplication/);
  assert.match(initialMigration, /noinherit/);
  assert.match(initialMigration, /nobypassrls/);
  assert.match(initialMigration, /pg_catalog\.pg_auth_members/);
  assert.match(
    initialMigration,
    /raise exception 'agent_outbox_app must be a restricted non-bypass role before migrations run'/
  );
  assert.match(
    initialMigration,
    /raise exception 'agent_outbox_app must not be a member of any role before migrations run'/
  );
  assert.match(
    initialMigration,
    /grant usage on schema extensions to agent_outbox_app;/
  );
  assert.doesNotMatch(initialMigration, /timezone\('utc', now\(\)\)/);
  assert.match(
    initialMigration,
    /create trigger agent_outbox_accounts_audit_id_immutable/
  );
  assert.match(
    initialMigration,
    /create trigger agent_outbox_callers_audit_id_immutable/
  );
});
