import pg from "pg";

const { Client } = pg;

/**
 * Asserts the connected session user is a valid gated-database-test owner:
 * it must be a migration owner (superuser or BYPASSRLS) and it must actually
 * be able to `set role agent_outbox_app`, which the tests rely on to exercise
 * restricted app-role behavior.
 *
 * @param {import("pg").Client} client
 * @returns {Promise<void>}
 */
export async function assertMigrationOwnerCanSetAppRole(client) {
  const roleState = await client.query(
    `
      select role_state.rolsuper or role_state.rolbypassrls as valid_migration_owner
      from pg_catalog.pg_roles role_state
      where role_state.rolname = session_user
    `
  );
  if (roleState.rows[0]?.valid_migration_owner !== true) {
    throw new Error(
      "DATABASE_MIGRATION_URL must use a superuser or BYPASSRLS migration owner; the restricted runtime app role is not a migration role."
    );
  }
  try {
    await client.query("set role agent_outbox_app");
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === "42704") {
      throw new Error(
        "The agent_outbox_app role does not exist on the target database; apply the Flyway migrations to the target database before running the database tests.",
        { cause: error }
      );
    }
    throw new Error(
      "The migration owner cannot SET ROLE to agent_outbox_app; grant it SET-capable membership (for example `grant agent_outbox_app to <owner> with set true`) or connect as a superuser.",
      { cause: error }
    );
  }
  await client.query("reset role");
}

/**
 * Returns a teardown-stage runner that never throws: each failed stage is
 * collected into `errors` as `` `${stagePrefix} during ${stage}.` `` with the
 * original failure as its cause, so every remaining stage still runs.
 *
 * @param {Error[]} errors
 * @param {string} stagePrefix
 * @returns {(stage: string, callback: () => Promise<unknown>) => Promise<void>}
 */
export function teardownAttempt(errors, stagePrefix) {
  return async (stage, callback) => {
    try {
      await callback();
    } catch (error) {
      errors.push(
        new Error(`${stagePrefix} during ${stage}.`, { cause: error })
      );
    }
  };
}

/**
 * Runs `teardown` without letting a teardown failure mask a test-body
 * failure: when both fail, an AggregateError carrying both (with the body
 * error as cause) is thrown under `aggregateMessage`.
 *
 * @param {unknown} bodyError
 * @param {() => Promise<void>} teardown
 * @param {string} aggregateMessage
 * @returns {Promise<void>}
 */
export async function preserveBodyErrorDuringTeardown(
  bodyError,
  teardown,
  aggregateMessage
) {
  try {
    await teardown();
  } catch (teardownError) {
    if (bodyError !== undefined) {
      throw new AggregateError([bodyError, teardownError], aggregateMessage, {
        cause: bodyError
      });
    }
    throw teardownError;
  }
}

/**
 * @param {string} connectionString
 * @returns {Promise<import("pg").Client>}
 */
export async function connectedDatabaseClient(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}
