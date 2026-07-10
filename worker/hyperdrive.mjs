export const DATABASE_HYPERDRIVE_BINDING = "AGENT_OUTBOX_DATABASE";
export const DATABASE_CONNECTION_MODE_VAR =
  "AGENT_OUTBOX_DATABASE_CONNECTION_MODE";
export const DATABASE_CONNECTION_MODE_HYPERDRIVE = "hyperdrive";

/**
 * @param {unknown} env
 * @returns {string | null}
 */
export function hyperdriveConnectionString(env) {
  if (!env || typeof env !== "object") {
    return null;
  }

  const binding = /** @type {Record<string, unknown>} */ (env)[
    DATABASE_HYPERDRIVE_BINDING
  ];
  if (!binding || typeof binding !== "object") {
    return null;
  }

  const connectionString = /** @type {Record<string, unknown>} */ (binding)
    .connectionString;
  return typeof connectionString === "string" && connectionString.trim() !== ""
    ? connectionString
    : null;
}

/**
 * @param {unknown} env
 * @returns {Record<string, unknown> | unknown}
 */
export function runtimeDatabaseEnv(env) {
  if (!env || typeof env !== "object") {
    return env;
  }

  const workerEnv = /** @type {Record<string, unknown>} */ (env);
  const connectionString = hyperdriveConnectionString(env);
  if (connectionString) {
    return {
      ...workerEnv,
      DATABASE_APP_ROLE_URL: connectionString
    };
  }

  if (
    workerEnv[DATABASE_CONNECTION_MODE_VAR] ===
    DATABASE_CONNECTION_MODE_HYPERDRIVE
  ) {
    return {
      ...workerEnv,
      DATABASE_APP_ROLE_URL: ""
    };
  }

  return env;
}

/**
 * @param {unknown} env
 * @returns {string | undefined}
 */
export function runtimeDatabaseConnectionString(env) {
  const runtimeEnv = runtimeDatabaseEnv(env);
  if (!runtimeEnv || typeof runtimeEnv !== "object") {
    return undefined;
  }

  const connectionString = /** @type {Record<string, unknown>} */ (runtimeEnv)
    .DATABASE_APP_ROLE_URL;
  return typeof connectionString === "string" && connectionString.trim() !== ""
    ? connectionString
    : undefined;
}
