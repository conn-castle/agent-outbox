import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { callerCredentialLastUsedStatement } from "../src/server/caller-api-auth.ts";
import { runProductTransaction } from "../src/server/database.ts";
import {
  DATABASE_POLICY_VERIFICATION_SKIP,
  assertMigrationOwnerCanSetAppRole,
  phase3DatabaseVerificationUrl as resolvePhase3DatabaseVerificationUrl,
  preserveBodyErrorDuringTeardown,
  resetRoleAndRollback,
  teardownAttempt
} from "./helpers/database.mjs";

const { Client } = pg;

const phase3DatabaseVerificationUrl = resolvePhase3DatabaseVerificationUrl();

/**
 * @param {import("pg").Client} client
 * @param {{ accountA?: string, accountB?: string, accountAuditA?: string, accountAuditB?: string, userA?: string, ipQuotaAddress?: string }} ids
 */
async function cleanupPhase3DatabaseVerificationRows(client, ids) {
  if (
    !ids.accountA &&
    !ids.accountB &&
    !ids.accountAuditA &&
    !ids.accountAuditB &&
    !ids.userA &&
    !ids.ipQuotaAddress
  ) {
    return;
  }

  const cleanupRole = await client.query(
    `select rolsuper or rolbypassrls as bypasses_rls from pg_catalog.pg_roles where rolname = current_user`
  );
  const bypassesRls = cleanupRole.rows[0]?.bypasses_rls === true;
  if (!bypassesRls) {
    await client.query("set role agent_outbox_app");
  }
  await client.query("begin");

  try {
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.audit_break_glass",
      "on"
    ]);
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.auth_surface",
      "cleanup"
    ]);

    if (bypassesRls && (ids.accountAuditA || ids.accountAuditB)) {
      await client.query(
        `
          delete from public.agent_outbox_audit_events
          where account_audit_id = any($1::uuid[])
        `,
        [[ids.accountAuditA, ids.accountAuditB].filter(Boolean)]
      );
    }

    if (ids.ipQuotaAddress) {
      await client.query(
        `
          delete from public.agent_outbox_ip_quota_windows
          where ip_address = $1::inet
        `,
        [ids.ipQuotaAddress]
      );
    }

    for (const accountId of [ids.accountA, ids.accountB].filter(Boolean)) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        accountId
      ]);
      await client.query(
        `
          delete from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId]
      );
    }

    if (ids.userA) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      await client.query(
        `
          delete from public.agent_outbox_users
          where user_id = $1
        `,
        [ids.userA]
      );
    }

    await client.query("commit");
    if (!bypassesRls) {
      await client.query("reset role");
    }
  } catch (error) {
    await client.query("rollback");
    if (!bypassesRls) {
      await client.query("reset role");
    }
    throw error;
  }
}

test(
  "phase 3 local database enforces representative policies and shared cleanup",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async () => {
    const databaseVerificationUrl = phase3DatabaseVerificationUrl;
    assert.ok(databaseVerificationUrl);
    const client = new Client({
      application_name: "agent-outbox-phase3-db-verification",
      connectionString: databaseVerificationUrl
    });
    const runId = crypto.randomUUID();
    const accountLabelA = `phase3-a-${runId}`;
    const accountLabelB = `phase3-b-${runId}`;
    const ipQuotaAddress = `2001:db8::${runId.slice(0, 4)}:${runId.slice(4, 8)}`;
    const ipQuotaPolicyMetric = `phase3_policy_probe_${runId}`;
    /** @type {{ accountA?: string, accountB?: string, accountAuditA?: string, accountAuditB?: string, userA?: string, callerA?: string, callerA2?: string, callerB?: string, reclaimCaller?: string, auditPreservedCaller?: string, activatedPreservedCaller?: string, revokedPreservedCaller?: string, answeredInput?: string, fileOutputInput?: string, fileUploadInput?: string, output?: string, fileOutput?: string, ipQuotaAddress?: string }} */
    const ids = { ipQuotaAddress };
    /** @type {unknown} */
    let bodyError;

    await client.connect();

    try {
      const rolePosture = await client.query(
        `
          select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
          from pg_catalog.pg_roles
          where rolname = 'agent_outbox_app'
        `
      );
      assert.deepEqual(rolePosture.rows[0], {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false
      });
      const appRoleMemberships = await client.query(
        `
          select 1
          from pg_catalog.pg_auth_members membership
          join pg_catalog.pg_roles app_role
            on app_role.oid = membership.member
          where app_role.rolname = 'agent_outbox_app'
        `
      );
      assert.deepEqual(appRoleMemberships.rows, []);
      const extensionSchemaUsage = await client.query(
        "select has_schema_privilege('agent_outbox_app', 'extensions', 'usage') as app_usage"
      );
      assert.deepEqual(extensionSchemaUsage.rows[0], { app_usage: true });
      const functionPrivileges = await client.query(
        `
          select
            function_name,
            has_function_privilege('public', function_name, 'execute') as public_execute,
            has_function_privilege('agent_outbox_app', function_name, 'execute') as app_execute
          from unnest($1::text[]) as function_name
          order by function_name
        `,
        [
          [
            "public.agent_outbox_context_account_id()",
            "public.agent_outbox_context_user_id()",
            "public.agent_outbox_context_caller_id()",
            "public.agent_outbox_context_auth_surface()",
            "public.agent_outbox_context_has_account_membership()",
            "public.agent_outbox_context_allows_account(uuid)",
            "public.agent_outbox_context_allows_caller(uuid)",
            "public.agent_outbox_context_allows_caller_audit_id(uuid)",
            "public.agent_outbox_lookup_caller_credential(text)",
            "public.agent_outbox_reject_account_audit_id_mutation()",
            "public.agent_outbox_reject_caller_audit_id_mutation()",
            "public.agent_outbox_reject_audit_mutation()",
            "public.agent_outbox_output_ack_already_recorded(uuid)",
            "public.agent_outbox_delete_output_result(uuid, text, text)",
            "public.agent_outbox_restore_unread_output(uuid, text)",
            "public.agent_outbox_delete_expired_outputs(timestamptz)",
            "public.agent_outbox_delete_retained_pending_inputs(timestamptz, text)",
            "public.agent_outbox_cleanup_downgrade_grace_expiry(bigint, timestamptz)",
            "public.agent_outbox_prune_quota_windows(timestamptz)",
            "public.agent_outbox_prune_ip_quota_windows(timestamptz)",
            "public.agent_outbox_prune_caller_setup_requests(timestamptz)",
            "public.agent_outbox_prune_never_activated_callers(timestamptz)",
            "public.agent_outbox_prune_expired_limit_blocks(timestamptz)",
            "public.agent_outbox_cleanup_account_targets()"
          ]
        ]
      );
      assert.deepEqual(
        functionPrivileges.rows.map((row) => ({
          public_execute: row.public_execute,
          app_execute: row.app_execute
        })),
        functionPrivileges.rows.map(() => ({
          public_execute: false,
          app_execute: true
        }))
      );
      const providerRoleRows = await client.query(
        `
          select rolname
          from pg_catalog.pg_roles
          where rolname = any($1::name[])
          order by rolname
        `,
        [["anon", "authenticated", "service_role"]]
      );
      for (const row of providerRoleRows.rows) {
        const providerFunctionPrivileges = await client.query(
          `
            select has_function_privilege($1, function_name, 'execute') as provider_execute
            from unnest($2::text[]) as function_name
            order by function_name
          `,
          [
            row.rolname,
            functionPrivileges.rows.map(
              (functionRow) => functionRow.function_name
            )
          ]
        );
        assert.deepEqual(
          providerFunctionPrivileges.rows.map(
            (privilegeRow) => privilegeRow.provider_execute
          ),
          providerFunctionPrivileges.rows.map(() => false)
        );
      }
      await assertMigrationOwnerCanSetAppRole(client);

      await client.query("set role agent_outbox_app");
      await client.query("begin");
      ids.accountA = crypto.randomUUID();
      ids.accountB = crypto.randomUUID();
      ids.userA = crypto.randomUUID();
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);

      const accountARows = await client.query(
        `
          insert into public.agent_outbox_accounts(account_id, label)
          values ($1, $2)
          returning account_audit_id
        `,
        [ids.accountA, accountLabelA]
      );
      ids.accountAuditA = accountARows.rows[0].account_audit_id;
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      const accountBRows = await client.query(
        `
          insert into public.agent_outbox_accounts(account_id, label)
          values ($1, $2)
          returning account_audit_id
        `,
        [ids.accountB, accountLabelB]
      );
      ids.accountAuditB = accountBRows.rows[0].account_audit_id;
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);

      await client.query(
        `
          insert into public.agent_outbox_users(user_id, clerk_user_id)
          values ($1, $2)
        `,
        [ids.userA, `phase3-user-${runId}`]
      );

      await client.query(
        `
          insert into public.agent_outbox_account_members(account_id, user_id, role)
          values ($1, $2, 'owner')
        `,
        [ids.accountA, ids.userA]
      );

      const callerARows = await client.query(
        `
          insert into public.agent_outbox_callers(account_id, display_name, caller_slug)
          values
            ($1, 'Caller A', $2),
            ($1, 'Caller A2', $3)
          returning caller_id, caller_slug
        `,
        [ids.accountA, `caller-a-${runId}`, `caller-a2-${runId}`]
      );
      for (const row of callerARows.rows) {
        if (row.caller_slug === `caller-a-${runId}`) {
          ids.callerA = row.caller_id;
        } else {
          ids.callerA2 = row.caller_id;
        }
      }
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      const callerBRows = await client.query(
        `
          insert into public.agent_outbox_callers(account_id, display_name, caller_slug)
          values ($1, 'Caller B', $2)
          returning caller_id
        `,
        [ids.accountB, `caller-b-${runId}`]
      );
      ids.callerB = callerBRows.rows[0].caller_id;
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);

      const abandonedCallerSlugs = {
        reclaim: `reclaim-${runId}`,
        audit: `preserve-audit-${runId}`,
        activated: `preserve-activated-${runId}`,
        revoked: `preserve-revoked-${runId}`
      };
      const abandonedCallerRows = await client.query(
        `
          insert into public.agent_outbox_callers(
            account_id,
            display_name,
            caller_slug,
            created_at,
            updated_at
          )
          values
            ($1, 'Reclaim abandoned caller', $2, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ($1, 'Audit preserved caller', $3, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ($1, 'Activated preserved caller', $4, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ($1, 'Revoked preserved caller', $5, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
          returning caller_id, caller_slug, caller_audit_id
        `,
        [
          ids.accountA,
          abandonedCallerSlugs.reclaim,
          abandonedCallerSlugs.audit,
          abandonedCallerSlugs.activated,
          abandonedCallerSlugs.revoked
        ]
      );
      const abandonedCallerRowsBySlug = new Map(
        abandonedCallerRows.rows.map((row) => [row.caller_slug, row])
      );
      ids.reclaimCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.reclaim
      )?.caller_id;
      ids.auditPreservedCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.audit
      )?.caller_id;
      ids.activatedPreservedCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.activated
      )?.caller_id;
      ids.revokedPreservedCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.revoked
      )?.caller_id;
      assert.ok(ids.reclaimCaller);
      assert.ok(ids.auditPreservedCaller);
      assert.ok(ids.activatedPreservedCaller);
      assert.ok(ids.revokedPreservedCaller);
      const auditPreservedCallerAuditId = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.audit
      )?.caller_audit_id;
      assert.ok(auditPreservedCallerAuditId);

      await client.query(
        `
          insert into public.agent_outbox_audit_events(
            event_type,
            account_audit_id,
            caller_audit_id,
            request_id
          )
          values ('caller_registered', $1, $2, $3)
        `,
        [ids.accountAuditA, auditPreservedCallerAuditId, `audit-${runId}`]
      );

      const credentialKeyId = `key-${runId}`;
      const credentialA2KeyId = `key-a2-${runId}`;
      const credentialDigest = "c".repeat(64);
      const credentialRows = await client.query(
        `
          insert into public.agent_outbox_caller_credentials(
            account_id,
            caller_id,
            key_id,
            key_prefix,
            key_last_four,
            secret_hmac_sha256,
            status,
            activated_at
          )
          values
            ($1, $2, $3, 'aob_live_phase3_test', 'test', $4, 'active', '2026-06-30T12:00:00.000Z'),
            ($1, $5, $6, 'aob_live_phase3_a2', 'a2ky', $7, 'active', '2026-06-30T12:00:00.000Z')
          returning caller_credential_id, key_id
        `,
        [
          ids.accountA,
          ids.callerA,
          credentialKeyId,
          credentialDigest,
          ids.callerA2,
          credentialA2KeyId,
          "d".repeat(64)
        ]
      );
      const credentialIdsByKeyId = new Map(
        credentialRows.rows.map((row) => [row.key_id, row.caller_credential_id])
      );
      const activeCredentialAId = credentialIdsByKeyId.get(credentialKeyId);
      const activeCredentialA2Id = credentialIdsByKeyId.get(credentialA2KeyId);
      assert.ok(activeCredentialAId);
      assert.ok(activeCredentialA2Id);

      const abandonedSetupLabels = {
        reclaim: `abandoned-reclaim-${runId}`,
        audit: `abandoned-audit-${runId}`
      };
      const abandonedSetupRows = await client.query(
        `
          insert into public.agent_outbox_caller_setup_requests(
            operation,
            flow,
            local_caller_name,
            display_name,
            callback_url,
            account_id,
            caller_id,
            approved_by_user_id,
            status,
            expires_at,
            updated_at,
            approved_at,
            exchanged_at
          )
          values
            ('connect', 'browser', $1, 'Abandoned reclaim', 'http://127.0.0.1/callback', $3, $4, $6, 'exchanged', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ('connect', 'browser', $2, 'Abandoned audit', 'http://127.0.0.1/callback', $3, $5, $6, 'exchanged', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
          returning setup_request_id, local_caller_name
        `,
        [
          abandonedSetupLabels.reclaim,
          abandonedSetupLabels.audit,
          ids.accountA,
          ids.reclaimCaller,
          ids.auditPreservedCaller,
          ids.userA
        ]
      );
      const abandonedSetupIdsByLabel = new Map(
        abandonedSetupRows.rows.map((row) => [
          row.local_caller_name,
          row.setup_request_id
        ])
      );
      const reclaimSetupRequestId = abandonedSetupIdsByLabel.get(
        abandonedSetupLabels.reclaim
      );
      const auditSetupRequestId = abandonedSetupIdsByLabel.get(
        abandonedSetupLabels.audit
      );
      assert.ok(reclaimSetupRequestId);
      assert.ok(auditSetupRequestId);

      await client.query(
        `
          insert into public.agent_outbox_caller_credentials(
            account_id,
            caller_id,
            key_id,
            key_prefix,
            key_last_four,
            secret_hmac_sha256,
            status,
            activated_at,
            revoked_at,
            expires_at,
            last_used_at,
            pending_replacement_setup_request_id
          )
          values
            ($1, $2, $3, 'aob_live_abandoned', 'abnd', $4, 'pending_activation', null, null, '2026-06-02T00:00:00.000Z', null, $5),
            ($1, $6, $7, 'aob_live_abandoned_audit', 'aadt', $8, 'pending_activation', null, null, '2026-06-02T00:00:00.000Z', null, $9),
            ($1, $10, $11, 'aob_live_activated', 'actv', $12, 'expired', '2026-06-01T00:00:00.000Z', null, '2026-06-02T00:00:00.000Z', null, null),
            ($1, $13, $14, 'aob_live_revoked', 'rvkd', $15, 'expired', null, '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', null, null)
        `,
        [
          ids.accountA,
          ids.reclaimCaller,
          `abandoned-${runId}`,
          "1".repeat(64),
          reclaimSetupRequestId,
          ids.auditPreservedCaller,
          `abandoned-audit-${runId}`,
          "2".repeat(64),
          auditSetupRequestId,
          ids.activatedPreservedCaller,
          `activated-history-${runId}`,
          "3".repeat(64),
          ids.revokedPreservedCaller,
          `revoked-history-${runId}`,
          "4".repeat(64)
        ]
      );

      const setupPrunePrefix = `setup-prune-${runId}`;
      const setupLabels = {
        terminalStale: `${setupPrunePrefix}-terminal-stale`,
        terminalFresh: `${setupPrunePrefix}-terminal-fresh`,
        pendingExpired: `${setupPrunePrefix}-pending-expired`,
        pendingLive: `${setupPrunePrefix}-pending-live`,
        approvedExpired: `${setupPrunePrefix}-approved-expired`,
        referencedPendingReplacement: `${setupPrunePrefix}-referenced-pending-replacement`,
        cascadeProbe: `setup-cascade-${runId}`,
        duplicatePendingProbe: `setup-duplicate-pending-${runId}`
      };
      const setupRows = await client.query(
        `
          insert into public.agent_outbox_caller_setup_requests(
            operation,
            flow,
            local_caller_name,
            display_name,
            callback_url,
            account_id,
            caller_id,
            approved_by_user_id,
            status,
            expires_at,
            updated_at,
            approved_at,
            exchanged_at,
            denied_at
          )
          values
            ('connect', 'browser', $1, 'Terminal stale', 'http://127.0.0.1/callback', $9, $10, $12, 'exchanged', '2026-07-14T12:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null),
            ('connect', 'browser', $2, 'Terminal fresh', 'http://127.0.0.1/callback', $9, $10, $12, 'denied', '2026-06-01T00:00:00.000Z', '2026-06-20T00:00:00.000Z', null, null, '2026-06-20T00:00:00.000Z'),
            ('connect', 'browser', $3, 'Pending expired', 'http://127.0.0.1/callback', $9, $10, null, 'pending', '2026-06-01T00:00:00.000Z', '2026-06-20T00:00:00.000Z', null, null, null),
            ('connect', 'browser', $4, 'Pending live', 'http://127.0.0.1/callback', $9, $10, null, 'pending', '2026-06-20T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null, null),
            ('connect', 'browser', $5, 'Approved expired', 'http://127.0.0.1/callback', $9, $10, $12, 'approved', '2026-06-01T00:00:00.000Z', '2026-06-20T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null),
            ('rotate', 'browser', $6, 'Referenced pending replacement', 'http://127.0.0.1/callback', $9, $10, $12, 'approved', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null),
            ('rotate', 'browser', $7, 'Cascade probe', 'http://127.0.0.1/callback', $9, $11, $12, 'approved', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null),
            ('rotate', 'browser', $8, 'Duplicate pending probe', 'http://127.0.0.1/callback', $9, $10, $12, 'approved', '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', null, null)
          returning setup_request_id, local_caller_name
        `,
        [
          setupLabels.terminalStale,
          setupLabels.terminalFresh,
          setupLabels.pendingExpired,
          setupLabels.pendingLive,
          setupLabels.approvedExpired,
          setupLabels.referencedPendingReplacement,
          setupLabels.cascadeProbe,
          setupLabels.duplicatePendingProbe,
          ids.accountA,
          ids.callerA,
          ids.callerA2,
          ids.userA
        ]
      );
      const setupRequestIdsByLabel = new Map(
        setupRows.rows.map((row) => [
          row.local_caller_name,
          row.setup_request_id
        ])
      );
      const referencedSetupRequestId = setupRequestIdsByLabel.get(
        setupLabels.referencedPendingReplacement
      );
      const cascadeSetupRequestId = setupRequestIdsByLabel.get(
        setupLabels.cascadeProbe
      );
      const duplicatePendingSetupRequestId = setupRequestIdsByLabel.get(
        setupLabels.duplicatePendingProbe
      );
      assert.ok(referencedSetupRequestId);
      assert.ok(cascadeSetupRequestId);
      assert.ok(duplicatePendingSetupRequestId);

      const pendingReplacementKeyId = `pending-${runId}`;
      const cascadePendingReplacementKeyId = `pending-cascade-${runId}`;
      await client.query(
        `
          insert into public.agent_outbox_caller_credentials(
            account_id,
            caller_id,
            key_id,
            key_prefix,
            key_last_four,
            secret_hmac_sha256,
            status,
            expires_at,
            pending_replacement_for_credential_id,
            pending_replacement_setup_request_id
          )
          values
            ($1, $2, $3, 'aob_live_pending_a', 'pend', $4, 'pending_activation', '2026-07-01T00:00:00.000Z', $5, $6),
            ($1, $7, $8, 'aob_live_pending_a2', 'pa2k', $9, 'pending_activation', '2026-07-01T00:00:00.000Z', $10, $11)
        `,
        [
          ids.accountA,
          ids.callerA,
          pendingReplacementKeyId,
          "e".repeat(64),
          activeCredentialAId,
          referencedSetupRequestId,
          ids.callerA2,
          cascadePendingReplacementKeyId,
          "f".repeat(64),
          activeCredentialA2Id,
          cascadeSetupRequestId
        ]
      );

      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      const inputBRows = await client.query(
        `
          insert into public.agent_outbox_input_items(
            account_id, caller_id, caller_item_id, caller_item_id_hash,
            row_type_display, row_type_icon, title_html, subtitle_html,
            summary_html, status, non_file_payload_bytes, updated_at
          )
          values ($1, $2, 'item-b', $3, 'Review', 'Inbox', 'Title B', 'Subtitle B', 'Summary B', 'pending', 10, '2026-06-30T12:00:00.000Z')
          returning input_item_id, caller_item_id
        `,
        [ids.accountB, ids.callerB, `hash-b-${runId}`]
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      const inputARows = await client.query(
        `
          insert into public.agent_outbox_input_items(
            account_id,
            caller_id,
            caller_item_id,
            caller_item_id_hash,
            row_type_display,
            row_type_icon,
            title_html,
            subtitle_html,
            summary_html,
            status,
            non_file_payload_bytes,
            updated_at,
            answered_at
          )
          values
            ($1, $2, 'item-a', $3, 'Review', 'Inbox', 'Title A', 'Subtitle A', 'Summary A', 'pending', 10, '2026-06-30T12:00:00.000Z', null),
            ($1, $4, 'item-a2', $5, 'Review', 'Inbox', 'Title A2', 'Subtitle A2', 'Summary A2', 'pending', 10, '2026-06-30T12:00:00.000Z', null),
            ($1, $2, 'answered-over-cap', $6, 'Review', 'Inbox', 'Answered title', 'Answered subtitle', 'Answered summary', 'answered', 100, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
            ($1, $2, 'ack-output', $7, 'Review', 'Inbox', 'Ack title', 'Ack subtitle', 'Ack summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'timeout-output', $8, 'Review', 'Inbox', 'Timeout title', 'Timeout subtitle', 'Timeout summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'undo-output', $9, 'Review', 'Inbox', 'Undo title', 'Undo subtitle', 'Undo summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'retained-pending', $10, 'Review', 'Inbox', 'Retention title', 'Retention subtitle', 'Retention summary', 'pending', 10, '2026-01-01T00:00:00.000Z', null),
            ($1, $2, 'file-output', $11, 'Review', 'Inbox', 'File output title', 'File output subtitle', 'File output summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'file-upload-pending', $12, 'Review', 'Inbox', 'File upload title', 'File upload subtitle', 'File upload summary', 'pending', 12, '2026-06-29T12:00:00.000Z', null)
          returning input_item_id, caller_item_id
        `,
        [
          ids.accountA,
          ids.callerA,
          `hash-a-${runId}`,
          ids.callerA2,
          `hash-a2-${runId}`,
          `hash-answered-${runId}`,
          `hash-ack-${runId}`,
          `hash-timeout-${runId}`,
          `hash-undo-${runId}`,
          `hash-retained-${runId}`,
          `hash-file-output-${runId}`,
          `hash-file-upload-${runId}`
        ]
      );
      const inputRows = {
        rows: [...inputARows.rows, ...inputBRows.rows]
      };
      const inputIdsByCallerItemId = new Map(
        inputRows.rows.map((row) => [row.caller_item_id, row.input_item_id])
      );
      ids.answeredInput = inputIdsByCallerItemId.get("answered-over-cap");
      ids.fileOutputInput = inputIdsByCallerItemId.get("file-output");
      ids.fileUploadInput = inputIdsByCallerItemId.get("file-upload-pending");

      await client.query(
        `
          insert into public.agent_outbox_input_actions(
            input_item_id,
            display_order,
            display,
            icon,
            action_value,
            popup_kind
          )
          values ($1, 0, 'Upload', 'upload', 'upload', 'file_upload')
        `,
        [ids.fileUploadInput]
      );

      /**
       * @param {string} callerItemId
       * @param {string} expiresAt
       * @returns {Promise<string>}
       */
      async function createOutput(callerItemId, expiresAt) {
        const output = await client.query(
          `
            insert into public.agent_outbox_output_results(
              account_id,
              caller_id,
              input_item_id,
              caller_item_id,
              action_value,
              response_kind,
              response_payload,
              response_payload_bytes,
              expires_at
            )
            values (
              $1,
              $2,
              $3,
              $4,
              'approve',
              'none',
              '{}'::jsonb,
              25,
              $5
            )
            returning output_result_id
          `,
          [
            ids.accountA,
            ids.callerA,
            inputIdsByCallerItemId.get(callerItemId),
            callerItemId,
            expiresAt
          ]
        );

        return output.rows[0].output_result_id;
      }

      ids.output = await createOutput(
        "answered-over-cap",
        "2026-07-14T12:00:00.000Z"
      );
      const ackOutputId = await createOutput(
        "ack-output",
        "2026-07-14T12:00:00.000Z"
      );
      const timeoutOutputId = await createOutput(
        "timeout-output",
        "2026-06-30T11:59:00.000Z"
      );
      const undoOutputId = await createOutput(
        "undo-output",
        "2026-07-14T12:00:00.000Z"
      );
      ids.fileOutput = await createOutput(
        "file-output",
        "2026-07-14T12:00:00.000Z"
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      const accountBOutput = await client.query(
        `
          insert into public.agent_outbox_output_results(
            account_id,
            caller_id,
            input_item_id,
            caller_item_id,
            action_value,
            response_kind,
            response_payload,
            response_payload_bytes,
            expires_at
          )
          values (
            $1,
            $2,
            $3,
            'item-b',
            'approve',
            'none',
            '{}'::jsonb,
            25,
            '2026-07-14T12:00:00.000Z'
          )
          returning output_result_id
        `,
        [ids.accountB, ids.callerB, inputIdsByCallerItemId.get("item-b")]
      );
      const accountBOutputId = accountBOutput.rows[0].output_result_id;
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);

      await client.query(
        `
          insert into public.agent_outbox_output_files(
            output_result_id,
            account_id,
            caller_id,
            filename,
            mime_type,
            size_bytes,
            sha256,
            file_bytes
          )
          values
            ($1, $2, $3, 'ack.txt', 'text/plain', 3, repeat('a', 64), decode('61636b', 'hex')),
            ($4, $2, $3, 'undo.txt', 'text/plain', 4, repeat('b', 64), decode('756e646f', 'hex')),
            ($5, $2, $3, 'file-output.txt', 'text/plain', 5, repeat('e', 64), decode('66696c6531', 'hex'))
        `,
        [ackOutputId, ids.accountA, ids.callerA, undoOutputId, ids.fileOutput]
      );

      /**
       * @param {string} authSurface
       * @param {{ accountId?: string, callerId?: string, userId?: string }} context
       */
      async function setOperationContext(authSurface, context = {}) {
        const settings = {
          "agent_outbox.auth_surface": authSurface,
          "agent_outbox.account_id": context.accountId ?? "",
          "agent_outbox.caller_id": context.callerId ?? "",
          "agent_outbox.user_id": context.userId ?? ""
        };

        for (const [name, value] of Object.entries(settings)) {
          await client.query("select set_config($1, $2, true)", [name, value]);
        }
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");

      await setOperationContext("human", {
        accountId: ids.accountA,
        userId: ids.userA
      });
      const humanAcknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-deny-human-ack'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(humanAcknowledgementDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("caller", {
        accountId: ids.accountA,
        callerId: ids.callerA
      });
      const callerTimeoutDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'output_timeout',
            'phase3-deny-caller-timeout'
          )
        `,
        [timeoutOutputId]
      );
      assert.deepEqual(callerTimeoutDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("cleanup", {
        accountId: ids.accountA
      });
      const cleanupAcknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-deny-cleanup-ack'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(cleanupAcknowledgementDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("caller", {
        accountId: ids.accountA,
        callerId: ids.callerA2
      });
      const wrongCallerAcknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-deny-wrong-caller-ack'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(wrongCallerAcknowledgementDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("caller", {
        accountId: ids.accountA,
        callerId: ids.callerA
      });
      const callerUndoRestore = await client.query(
        "select * from public.agent_outbox_restore_unread_output($1, 'phase3-deny-caller-undo')",
        [undoOutputId]
      );
      assert.deepEqual(callerUndoRestore.rows[0], {
        output_deleted: false,
        input_restored: false,
        files_deleted: 0
      });

      await setOperationContext("cleanup", {
        accountId: ids.accountA
      });
      const cleanupUndoRestore = await client.query(
        "select * from public.agent_outbox_restore_unread_output($1, 'phase3-deny-cleanup-undo')",
        [undoOutputId]
      );
      assert.deepEqual(cleanupUndoRestore.rows[0], {
        output_deleted: false,
        input_restored: false,
        files_deleted: 0
      });

      const operationAuthPreservation = await client.query(
        `
          select
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $1) as ack_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $2) as timeout_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $3) as undo_output_count,
            (select count(*)::int from public.agent_outbox_output_files where output_result_id in ($1, $3)) as file_count
        `,
        [ackOutputId, timeoutOutputId, undoOutputId]
      );
      assert.deepEqual(operationAuthPreservation.rows[0], {
        ack_output_count: 1,
        timeout_output_count: 1,
        undo_output_count: 1,
        file_count: 2
      });
      await client.query("reset role");
      await client.query("commit");

      await client.query(
        `
          insert into public.agent_outbox_account_quota_windows(
            account_id,
            metric,
            window_kind,
            window_start_utc,
            used_units,
            updated_at
          )
          values ($1, 'input_submissions_per_day', 'day', '2026-06-01T00:00:00.000Z', 5, '2026-06-01T00:00:00.000Z')
        `,
        [ids.accountA]
      );

      await client.query(
        `
          insert into public.agent_outbox_ip_quota_windows(
            ip_address,
            metric,
            window_kind,
            window_start_utc,
            used_units,
            updated_at
          )
          values (
            $1::inet,
            'caller_connect_start_requests_per_ip_per_minute',
            'minute',
            '2026-06-01T00:00:00.000Z',
            5,
            '2026-06-01T00:00:00.000Z'
          )
        `,
        [ids.ipQuotaAddress]
      );

      await client.query(
        `
          insert into public.agent_outbox_account_limit_blocks(
            account_id,
            operation_kind,
            limit_name,
            limit_reason_code,
            limit_reason,
            limit_resets_at,
            used_units,
            limit_units
          )
          values (
            $1,
            'output_check_read',
            'output_check_read_requests_per_account_per_minute',
            'output_check_read_rate_limited',
            'Output check/read requests are temporarily rate limited.',
            '2026-06-30T11:59:00.000Z',
            121,
            120
          )
        `,
        [ids.accountA]
      );

      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      const directCredentialRows = await client.query(
        `
          select key_id
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      assert.deepEqual(directCredentialRows.rows, []);
      const lookedUpCredential = await client.query(
        `
          select *
          from public.agent_outbox_lookup_caller_credential($1)
        `,
        [credentialKeyId]
      );
      assert.deepEqual(lookedUpCredential.rows[0], {
        account_id: ids.accountA,
        caller_id: ids.callerA,
        key_id: credentialKeyId,
        key_prefix: "aob_live_phase3_test",
        key_last_four: "test",
        secret_hmac_sha256: credentialDigest,
        status: "active",
        revoked_at: null,
        expires_at: null
      });
      await client.query("reset role");
      await client.query("commit");

      const lastUsedAccountId = ids.accountA;
      const lastUsedCallerId = ids.callerA;
      assert.ok(lastUsedAccountId);
      assert.ok(lastUsedCallerId);
      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = '2026-06-30T11:00:00.000Z'
          where key_id = $1
        `,
        [credentialA2KeyId]
      );

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await setOperationContext("caller", {
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId
      });
      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = null
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const nullLastUsedStatement = callerCredentialLastUsedStatement({
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId,
        keyId: credentialKeyId
      });
      const nullLastUsedUpdate = await client.query(
        nullLastUsedStatement.sql,
        nullLastUsedStatement.values ?? []
      );
      assert.equal(nullLastUsedUpdate.rowCount, 1);
      const nullLastUsedRows = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      assert.ok(nullLastUsedRows.rows[0].last_used_at);

      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = '2026-06-30T11:00:00.000Z'
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const staleLastUsedStatement = callerCredentialLastUsedStatement({
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId,
        keyId: credentialKeyId
      });
      const staleLastUsedUpdate = await client.query(
        staleLastUsedStatement.sql,
        staleLastUsedStatement.values ?? []
      );
      assert.equal(staleLastUsedUpdate.rowCount, 1);
      const scopedLastUsedRows = await client.query(
        `
          select key_id, last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
          order by key_id
        `,
        [credentialKeyId]
      );
      assert.deepEqual(
        scopedLastUsedRows.rows.map((row) => row.key_id),
        [credentialKeyId]
      );
      assert.notEqual(
        scopedLastUsedRows.rows[0].last_used_at.toISOString(),
        "2026-06-30T11:00:00.000Z"
      );

      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = now()
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const freshLastUsedBefore = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const freshLastUsedStatement = callerCredentialLastUsedStatement({
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId,
        keyId: credentialKeyId
      });
      const freshLastUsedUpdate = await client.query(
        freshLastUsedStatement.sql,
        freshLastUsedStatement.values ?? []
      );
      assert.equal(freshLastUsedUpdate.rowCount, 0);
      const freshLastUsedAfter = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      assert.equal(
        freshLastUsedAfter.rows[0].last_used_at.toISOString(),
        freshLastUsedBefore.rows[0].last_used_at.toISOString()
      );
      await client.query("reset role");
      await client.query("commit");

      const otherCallerLastUsedRows = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialA2KeyId]
      );
      assert.equal(
        otherCallerLastUsedRows.rows[0].last_used_at.toISOString(),
        "2026-06-30T11:00:00.000Z"
      );

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_caller_credentials(
                account_id,
                caller_id,
                key_id,
                key_prefix,
                key_last_four,
                secret_hmac_sha256,
                status,
                expires_at,
                pending_replacement_for_credential_id,
                pending_replacement_setup_request_id
              )
              values (
                $1,
                $2,
                $3,
                'aob_live_pending_dup',
                'pdup',
                $4,
                'pending_activation',
                '2026-07-01T00:00:00.000Z',
                $5,
                $6
              )
            `,
            [
              ids.accountA,
              ids.callerA,
              `pending-duplicate-${runId}`,
              "a".repeat(64),
              activeCredentialAId,
              duplicatePendingSetupRequestId
            ]
          ),
          (error) => {
            const databaseError =
              /** @type {{ code?: string, constraint?: string }} */ (error);
            assert.equal(databaseError.code, "23505");
            assert.equal(
              databaseError.constraint,
              "agent_outbox_one_pending_replacement_per_caller"
            );
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      const cascadePendingBefore = await client.query(
        `
          select count(*)::int as credential_count
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [cascadePendingReplacementKeyId]
      );
      assert.equal(cascadePendingBefore.rows[0].credential_count, 1);
      const deletedCascadeSetup = await client.query(
        `
          delete from public.agent_outbox_caller_setup_requests
          where setup_request_id = $1
          returning setup_request_id
        `,
        [cascadeSetupRequestId]
      );
      assert.equal(deletedCascadeSetup.rows.length, 1);
      const cascadePendingAfter = await client.query(
        `
          select count(*)::int as credential_count
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [cascadePendingReplacementKeyId]
      );
      assert.equal(cascadePendingAfter.rows[0].credential_count, 0);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              update public.agent_outbox_accounts
              set account_audit_id = '00000000-0000-0000-0000-000000000001'
              where account_id = $1
            `,
            [ids.accountA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              update public.agent_outbox_callers
              set caller_audit_id = '00000000-0000-0000-0000-000000000002'
              where caller_id = $1
            `,
            [ids.callerA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      const humanNonMemberRows = await client.query(
        `
          select caller_item_id
          from public.agent_outbox_input_items
          where caller_item_id = 'item-b'
        `
      );
      assert.deepEqual(humanNonMemberRows.rows, []);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_output_results(
                account_id,
                caller_id,
                input_item_id,
                caller_item_id,
                action_value,
                response_kind,
                response_payload,
                response_payload_bytes,
                expires_at
              )
              values (
                $1,
                $2,
                $3,
                'item-a2',
                'approve',
                'none',
                '{}'::jsonb,
                25,
                '2026-07-14T12:00:00.000Z'
              )
            `,
            [ids.accountA, ids.callerA, inputIdsByCallerItemId.get("item-a2")]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "23503");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_output_files(
                output_result_id,
                account_id,
                caller_id,
                filename,
                mime_type,
                size_bytes,
                sha256,
                file_bytes
              )
              values ($1, $2, $3, 'bad.txt', 'text/plain', 3, repeat('d', 64), decode('626164', 'hex'))
            `,
            [accountBOutputId, ids.accountA, ids.callerA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "23503");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_output_files(
                output_result_id,
                account_id,
                caller_id,
                display_order,
                filename,
                mime_type,
                size_bytes,
                sha256,
                file_bytes
              )
              values ($1, $2, $3, 1, 'duplicate.txt', 'text/plain', 3, repeat('f', 64), decode('647570', 'hex'))
            `,
            [ackOutputId, ids.accountA, ids.callerA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "23505");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.caller_id",
        ids.callerA
      ]);
      const visibleItems = await client.query(
        `
          select caller_item_id
          from public.agent_outbox_input_items
          where caller_item_id in ('answered-over-cap', 'item-a', 'item-a2', 'item-b')
          order by caller_item_id
        `
      );
      assert.deepEqual(
        visibleItems.rows.map((row) => row.caller_item_id),
        ["answered-over-cap", "item-a"]
      );
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      const missingCallerItems = await client.query(
        `
          select caller_item_id
          from public.agent_outbox_input_items
          where caller_item_id in ('answered-over-cap', 'item-a', 'item-a2', 'item-b')
        `
      );
      assert.deepEqual(missingCallerItems.rows, []);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "control_plane"
      ]);
      const controlPlaneIpQuota = await client.query(
        `
          insert into public.agent_outbox_ip_quota_windows(
            ip_address,
            metric,
            window_kind,
            window_start_utc,
            used_units,
            updated_at
          )
          values (
            $1::inet,
            $2,
            'minute',
            '2026-06-20T00:00:00.000Z',
            2,
            '2026-06-20T00:00:00.000Z'
          )
          returning metric, window_kind, used_units::int as used_units
        `,
        [ids.ipQuotaAddress, ipQuotaPolicyMetric]
      );
      assert.deepEqual(controlPlaneIpQuota.rows, [
        { metric: ipQuotaPolicyMetric, window_kind: "minute", used_units: 2 }
      ]);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      for (const [name, sql] of [
        [
          "ip_quota",
          "select public.agent_outbox_prune_ip_quota_windows('2026-06-15T00:00:00.000Z')"
        ],
        [
          "caller_setup",
          "select public.agent_outbox_prune_caller_setup_requests('2026-06-15T00:00:00.000Z')"
        ],
        [
          "account_targets",
          "select * from public.agent_outbox_cleanup_account_targets()"
        ],
        [
          "stripe_webhooks",
          "select public.agent_outbox_prune_stripe_webhook_events('2026-06-15T00:00:00.000Z')"
        ]
      ]) {
        await client.query(`savepoint unset_auth_surface_${name}`);
        try {
          await assert.rejects(client.query(sql), (error) => {
            assert.equal(
              /** @type {{ code?: string }} */ (error).code,
              "42501"
            );
            return true;
          });
        } finally {
          await client.query(
            `rollback to savepoint unset_auth_surface_${name}`
          );
        }
      }
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              update public.agent_outbox_ip_quota_windows
              set used_units = used_units + 1
              where ip_address = $1::inet
                and metric = $2
            `,
            [ids.ipQuotaAddress, ipQuotaPolicyMetric]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_ip_quota_windows(
                ip_address,
                metric,
                window_kind,
                window_start_utc,
                used_units,
                updated_at
              )
              values (
                $1::inet,
                $2,
                'minute',
                '2026-06-20T00:00:00.000Z',
                1,
                '2026-06-20T00:00:00.000Z'
              )
            `,
            [ids.ipQuotaAddress, `${ipQuotaPolicyMetric}_cleanup_insert`]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      const cleanupVisibleIpQuota = await client.query(
        `
          select metric, window_kind, used_units::int as used_units
          from public.agent_outbox_ip_quota_windows
          where ip_address = $1::inet
            and metric = $2
        `,
        [ids.ipQuotaAddress, ipQuotaPolicyMetric]
      );
      assert.deepEqual(cleanupVisibleIpQuota.rows, [
        { metric: ipQuotaPolicyMetric, window_kind: "minute", used_units: 2 }
      ]);
      const cleanupDeletedIpQuota = await client.query(
        `
          delete from public.agent_outbox_ip_quota_windows
          where ip_address = $1::inet
            and metric = $2
          returning metric
        `,
        [ids.ipQuotaAddress, ipQuotaPolicyMetric]
      );
      assert.deepEqual(cleanupDeletedIpQuota.rows, [
        { metric: ipQuotaPolicyMetric }
      ]);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "control_plane"
      ]);
      await client.query(
        `
          insert into public.agent_outbox_stripe_webhook_events(
            stripe_event_id,
            event_type,
            received_at,
            processed_at
          )
          values
            ($1, 'checkout.session.completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ($2, 'customer.subscription.updated', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
        `,
        [`evt_old_${runId}`, `evt_recent_${runId}`]
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("savepoint non_cleanup_stripe_webhook_prune");
      await assert.rejects(
        client.query(
          "select public.agent_outbox_prune_stripe_webhook_events($1) as deleted_count",
          ["2026-04-01T00:00:00.000Z"]
        ),
        (error) => {
          const databaseError = /** @type {{ code?: string }} */ (error);
          assert.equal(databaseError.code, "42501");
          return true;
        }
      );
      await client.query(
        "rollback to savepoint non_cleanup_stripe_webhook_prune"
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      const prunedStripeWebhookEvents = await client.query(
        "select public.agent_outbox_prune_stripe_webhook_events($1)::int as deleted_count",
        ["2026-04-01T00:00:00.000Z"]
      );
      assert.deepEqual(prunedStripeWebhookEvents.rows, [{ deleted_count: 1 }]);
      const retainedStripeWebhookEvents = await client.query(
        `
          select stripe_event_id
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = any($1::text[])
          order by stripe_event_id
        `,
        [[`evt_old_${runId}`, `evt_recent_${runId}`]]
      );
      assert.deepEqual(
        retainedStripeWebhookEvents.rows.map((row) => row.stripe_event_id),
        [`evt_recent_${runId}`]
      );

      // Direct RLS verification for agent_outbox_stripe_webhook_events
      // Currently under "cleanup" surface
      const cleanupSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_recent_${runId}`]
      );
      assert.equal(cleanupSelect.rowCount, 1);

      await client.query("savepoint stripe_cleanup_insert_fail");
      await assert.rejects(
        client.query(
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'type')",
          [`evt_cleanup_insert_${runId}`]
        ),
        (error) => {
          const dbError = /** @type {{ code?: string }} */ (error);
          assert.equal(dbError.code, "42501");
          return true;
        }
      );
      await client.query("rollback to savepoint stripe_cleanup_insert_fail");

      const cleanupUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'updated' where stripe_event_id = $1",
        [`evt_recent_${runId}`]
      );
      assert.equal(cleanupUpdate.rowCount, 0);

      const cleanupDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_recent_${runId}`]
      );
      assert.equal(cleanupDelete.rowCount, 1);

      // Switch to control_plane surface
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "control_plane"
      ]);

      await client.query(
        "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'checkout.session.completed')",
        [`evt_cp_${runId}`]
      );

      const cpSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(cpSelect.rowCount, 1);

      const cpUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'checkout.session.async_payment_succeeded' where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(cpUpdate.rowCount, 1);

      const cpDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(cpDelete.rowCount, 0);

      // Switch to human surface
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);

      const humanSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(humanSelect.rowCount, 0);

      await client.query("savepoint stripe_human_insert_fail");
      await assert.rejects(
        client.query(
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'type')",
          [`evt_human_insert_${runId}`]
        ),
        (error) => {
          const dbError = /** @type {{ code?: string }} */ (error);
          assert.equal(dbError.code, "42501");
          return true;
        }
      );
      await client.query("rollback to savepoint stripe_human_insert_fail");

      const humanUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'updated' where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(humanUpdate.rowCount, 0);

      const humanDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(humanDelete.rowCount, 0);

      // Switch to caller surface
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);

      const callerSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(callerSelect.rowCount, 0);

      await client.query("savepoint stripe_caller_insert_fail");
      await assert.rejects(
        client.query(
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'type')",
          [`evt_caller_insert_${runId}`]
        ),
        (error) => {
          const dbError = /** @type {{ code?: string }} */ (error);
          assert.equal(dbError.code, "42501");
          return true;
        }
      );
      await client.query("rollback to savepoint stripe_caller_insert_fail");

      const callerUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'updated' where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(callerUpdate.rowCount, 0);

      const callerDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(callerDelete.rowCount, 0);

      await client.query("reset role");
      await client.query("rollback");

      const productTransactionProbe = await runProductTransaction(
        databaseVerificationUrl,
        {
          requestId: `phase3-tx-${runId}`,
          authSurface: "caller",
          accountId: ids.accountA,
          callerId: ids.callerA
        },
        async (query) => {
          await query({ sql: "set role agent_outbox_app" });
          const contextRows = await query({
            sql: `
              select
                current_setting('agent_outbox.request_id', true) as request_id,
                current_setting('agent_outbox.auth_surface', true) as auth_surface,
                current_setting('agent_outbox.account_id', true) as account_id,
                current_setting('agent_outbox.caller_id', true) as caller_id
            `
          });
          const itemRows = await query({
            sql: `
              select caller_item_id
              from public.agent_outbox_input_items
              where caller_item_id in ('item-a', 'item-a2', 'item-b')
              order by caller_item_id
            `
          });

          return {
            context: contextRows.rows[0],
            itemIds: itemRows.rows.map((row) => row.caller_item_id)
          };
        }
      );
      assert.deepEqual(productTransactionProbe, {
        context: {
          request_id: `phase3-tx-${runId}`,
          auth_surface: "caller",
          account_id: ids.accountA,
          caller_id: ids.callerA
        },
        itemIds: ["item-a"]
      });

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.caller_id",
        ids.callerA
      ]);
      const acknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-db-test'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(acknowledgementDeletion.rows[0], {
        output_deleted: true,
        input_deleted: true,
        files_deleted: 1
      });
      const duplicateAck = await client.query(
        "select public.agent_outbox_output_ack_already_recorded($1) as already_recorded",
        [ackOutputId]
      );
      assert.equal(duplicateAck.rows[0].already_recorded, true);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      const undoDeletion = await client.query(
        "select * from public.agent_outbox_restore_unread_output($1, 'phase3-db-test')",
        [undoOutputId]
      );
      assert.deepEqual(undoDeletion.rows[0], {
        output_deleted: true,
        input_restored: true,
        files_deleted: 1
      });
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      const expiredOutputs = await client.query(
        "select public.agent_outbox_delete_expired_outputs('2026-06-30T12:00:00.000Z') as deleted_count"
      );
      assert.equal(expiredOutputs.rows[0].deleted_count, 1);
      const retainedInputs = await client.query(
        "select public.agent_outbox_delete_retained_pending_inputs('2026-02-01T00:00:00.000Z') as deleted_count"
      );
      assert.equal(retainedInputs.rows[0].deleted_count, 1);
      const prunedQuotaWindows = await client.query(
        "select public.agent_outbox_prune_quota_windows('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedQuotaWindows.rows[0].deleted_count, 1);
      const prunedIpQuotaWindows = await client.query(
        "select public.agent_outbox_prune_ip_quota_windows('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedIpQuotaWindows.rows[0].deleted_count, 1);
      const prunedSetupRequests = await client.query(
        "select public.agent_outbox_prune_caller_setup_requests('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedSetupRequests.rows[0].deleted_count, 3);
      const prunedNeverActivatedCallers = await client.query(
        "select public.agent_outbox_prune_never_activated_callers('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedNeverActivatedCallers.rows[0].deleted_count, 1);
      const prunedLimitBlocks = await client.query(
        "select public.agent_outbox_prune_expired_limit_blocks('2026-06-30T12:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedLimitBlocks.rows[0].deleted_count, 1);
      const cleanupResult = await client.query(
        `
          select *
          from public.agent_outbox_cleanup_downgrade_grace_expiry(
            30,
            '2026-06-30T12:00:00.000Z'
          )
        `
      );
      assert.equal(cleanupResult.rows[0].oldest_inputs_deleted, 1);
      assert.equal(cleanupResult.rows[0].expired_outputs_deleted, 0);
      assert.equal(cleanupResult.rows[0].file_outputs_deleted, 1);
      assert.equal(cleanupResult.rows[0].file_inputs_deleted, 1);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      const accountlessPrunedSetupRequests = await client.query(
        "select public.agent_outbox_prune_caller_setup_requests('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(accountlessPrunedSetupRequests.rows[0].deleted_count, 0);
      await client.query("savepoint accountless_never_activated_prune");
      try {
        await assert.rejects(
          client.query(
            "select public.agent_outbox_prune_never_activated_callers('2026-06-15T00:00:00.000Z') as deleted_count"
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await client.query(
          "rollback to savepoint accountless_never_activated_prune"
        );
      }
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("savepoint non_cleanup_never_activated_prune");
      try {
        await assert.rejects(
          client.query(
            "select public.agent_outbox_prune_never_activated_callers('2026-06-15T00:00:00.000Z') as deleted_count"
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await client.query(
          "rollback to savepoint non_cleanup_never_activated_prune"
        );
      }
      await client.query("reset role");
      await client.query("commit");

      const accountlessCleanupPreservation = await client.query(
        `
          select
            (
              select count(*)::int
              from public.agent_outbox_caller_setup_requests
              where setup_request_id = $1
            ) as setup_request_count,
            (
              select count(*)::int
              from public.agent_outbox_caller_credentials
              where key_id = $2
                and pending_replacement_setup_request_id = $1
            ) as credential_count
        `,
        [referencedSetupRequestId, pendingReplacementKeyId]
      );
      assert.deepEqual(accountlessCleanupPreservation.rows[0], {
        setup_request_count: 1,
        credential_count: 1
      });

      const neverActivatedCleanupRows = await client.query(
        `
          select
            (select count(*)::int from public.agent_outbox_callers where caller_id = $1) as reclaimed_caller_count,
            (select count(*)::int from public.agent_outbox_caller_setup_requests where setup_request_id = $2) as reclaimed_setup_count,
            (select count(*)::int from public.agent_outbox_caller_credentials where key_id = $3) as reclaimed_credential_count,
            (select count(*)::int from public.agent_outbox_callers where caller_id = $4) as audit_preserved_caller_count,
            (select count(*)::int from public.agent_outbox_caller_setup_requests where setup_request_id = $5) as audit_preserved_setup_count,
            (select count(*)::int from public.agent_outbox_caller_credentials where key_id = $6) as audit_preserved_credential_count,
            (select count(*)::int from public.agent_outbox_callers where caller_id = $7) as activated_preserved_caller_count,
            (select count(*)::int from public.agent_outbox_callers where caller_id = $8) as revoked_preserved_caller_count
        `,
        [
          ids.reclaimCaller,
          reclaimSetupRequestId,
          `abandoned-${runId}`,
          ids.auditPreservedCaller,
          auditSetupRequestId,
          `abandoned-audit-${runId}`,
          ids.activatedPreservedCaller,
          ids.revokedPreservedCaller
        ]
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      assert.deepEqual(neverActivatedCleanupRows.rows[0], {
        reclaimed_caller_count: 0,
        reclaimed_setup_count: 0,
        reclaimed_credential_count: 0,
        audit_preserved_caller_count: 1,
        audit_preserved_setup_count: 1,
        audit_preserved_credential_count: 1,
        activated_preserved_caller_count: 1,
        revoked_preserved_caller_count: 1
      });

      const reusedCallerSlug = await client.query(
        `
          insert into public.agent_outbox_callers(account_id, display_name, caller_slug)
          values ($1, 'Reused reclaimed caller', $2)
          returning caller_slug
        `,
        [ids.accountA, abandonedCallerSlugs.reclaim]
      );
      assert.deepEqual(reusedCallerSlug.rows, [
        { caller_slug: abandonedCallerSlugs.reclaim }
      ]);

      const deletedRows = await client.query(
        `
          select
            (select count(*)::int from public.agent_outbox_input_items where input_item_id = $1) as input_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $2) as output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $3) as ack_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $4) as timeout_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $5) as undo_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $8) as file_output_count,
            (select count(*)::int from public.agent_outbox_output_files where output_result_id in ($3, $5, $8)) as file_count,
            (select status from public.agent_outbox_input_items where input_item_id = $6) as undo_input_status,
            (select count(*)::int from public.agent_outbox_input_items where caller_item_id = 'retained-pending' and account_id = $7) as retained_input_count,
            (select count(*)::int from public.agent_outbox_input_items where input_item_id = $9) as file_input_count,
            (select count(*)::int from public.agent_outbox_input_items where input_item_id = $10) as file_upload_input_count,
            (select count(*)::int from public.agent_outbox_account_quota_windows where account_id = $7) as quota_window_count,
            (select count(*)::int from public.agent_outbox_ip_quota_windows where ip_address = $11::inet) as ip_quota_window_count,
            (select count(*)::int from public.agent_outbox_account_limit_blocks where account_id = $7) as limit_block_count
        `,
        [
          ids.answeredInput,
          ids.output,
          ackOutputId,
          timeoutOutputId,
          undoOutputId,
          inputIdsByCallerItemId.get("undo-output"),
          ids.accountA,
          ids.fileOutput,
          ids.fileOutputInput,
          ids.fileUploadInput,
          ids.ipQuotaAddress
        ]
      );
      assert.deepEqual(deletedRows.rows[0], {
        input_count: 0,
        output_count: 0,
        ack_output_count: 0,
        timeout_output_count: 0,
        undo_output_count: 0,
        file_output_count: 0,
        file_count: 0,
        undo_input_status: "pending",
        retained_input_count: 0,
        file_input_count: 0,
        file_upload_input_count: 0,
        quota_window_count: 0,
        ip_quota_window_count: 0,
        limit_block_count: 0
      });

      const remainingSetupRequests = await client.query(
        `
          select local_caller_name
          from public.agent_outbox_caller_setup_requests
          where local_caller_name like $1
          order by local_caller_name
        `,
        [`${setupPrunePrefix}-%`]
      );
      assert.deepEqual(
        remainingSetupRequests.rows.map((row) => row.local_caller_name),
        [
          setupLabels.pendingLive,
          setupLabels.referencedPendingReplacement,
          setupLabels.terminalFresh
        ].sort()
      );
      const preservedPendingReplacement = await client.query(
        `
          select key_id, pending_replacement_setup_request_id::text as setup_request_id
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [pendingReplacementKeyId]
      );
      assert.deepEqual(preservedPendingReplacement.rows, [
        {
          key_id: pendingReplacementKeyId,
          setup_request_id: referencedSetupRequestId
        }
      ]);

      const auditRows = await client.query(
        `
          select event_type, deletion_reason
          from public.agent_outbox_audit_events
          where output_result_id = any($1::uuid[])
          order by deletion_reason, event_type
        `,
        [
          [
            ids.output,
            ackOutputId,
            timeoutOutputId,
            undoOutputId,
            ids.fileOutput
          ]
        ]
      );
      assert.deepEqual(auditRows.rows, [
        {
          event_type: "file_deleted",
          deletion_reason: "acknowledgement"
        },
        {
          event_type: "output_acknowledged",
          deletion_reason: "acknowledgement"
        },
        {
          event_type: "file_deleted",
          deletion_reason: "downgrade_grace_file_output"
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_file_output"
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_non_file_payload_limit"
        },
        {
          event_type: "output_deleted",
          deletion_reason: "output_timeout"
        },
        {
          event_type: "file_deleted",
          deletion_reason: "pre_read_undo"
        },
        {
          event_type: "output_undone",
          deletion_reason: "pre_read_undo"
        }
      ]);

      const terminalOutputByteAuditRows = await client.query(
        `
          select event_type, deletion_reason, non_file_bytes::int as non_file_bytes
          from public.agent_outbox_audit_events
          where output_result_id = any($1::uuid[])
            and event_type in ('output_acknowledged', 'output_deleted')
          order by deletion_reason, event_type
        `,
        [[ids.output, ackOutputId, timeoutOutputId, ids.fileOutput]]
      );
      assert.deepEqual(terminalOutputByteAuditRows.rows, [
        {
          event_type: "output_acknowledged",
          deletion_reason: "acknowledgement",
          non_file_bytes: 35
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_file_output",
          non_file_bytes: 35
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_non_file_payload_limit",
          non_file_bytes: 125
        },
        {
          event_type: "output_deleted",
          deletion_reason: "output_timeout",
          non_file_bytes: 35
        }
      ]);

      const retentionAuditRows = await client.query(
        `
          select
            event_type,
            deletion_reason,
            caller_item_id_hash,
            non_file_bytes::int as non_file_bytes
          from public.agent_outbox_audit_events
          where input_item_id = $1
        `,
        [inputIdsByCallerItemId.get("retained-pending")]
      );
      assert.deepEqual(retentionAuditRows.rows, [
        {
          event_type: "input_deleted",
          deletion_reason: "input_retention",
          caller_item_id_hash: `hash-retained-${runId}`,
          non_file_bytes: 10
        }
      ]);

      const fileUploadAuditRows = await client.query(
        `
          select
            event_type,
            deletion_reason,
            caller_item_id_hash,
            non_file_bytes::int as non_file_bytes
          from public.agent_outbox_audit_events
          where input_item_id = $1
        `,
        [ids.fileUploadInput]
      );
      assert.deepEqual(fileUploadAuditRows.rows, [
        {
          event_type: "input_deleted",
          deletion_reason: "downgrade_grace_file_input",
          caller_item_id_hash: `hash-file-upload-${runId}`,
          non_file_bytes: 12
        }
      ]);
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          /** @type {Error[]} */
          const teardownErrors = [];
          const attempt = teardownAttempt(
            teardownErrors,
            "Phase 3 database teardown failed"
          );
          await attempt("transaction and role reset", () =>
            resetRoleAndRollback(client)
          );
          await attempt("test row cleanup", () =>
            cleanupPhase3DatabaseVerificationRows(client, ids)
          );
          await attempt("client close", () => client.end());
          if (teardownErrors.length > 0) {
            throw new AggregateError(
              teardownErrors,
              "Phase 3 database teardown failed."
            );
          }
        },
        "Phase 3 database test and teardown both failed."
      );
    }
  }
);
