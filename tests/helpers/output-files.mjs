import { enforceCallerOperationLimits } from "../../src/server/caller-api-auth.ts";
import { outputFileDownloadInTransaction } from "../../src/server/output-files.ts";

/**
 * Runs the output-file download's in-transaction steps in production order:
 * caller request limits, then the download itself.
 *
 * @param {import("../../src/server/database.ts").ProductTransactionQuery} query
 * @param {import("../../src/server/api-errors.ts").ApiRequestContext} context
 * @param {import("../../src/server/caller-api-auth.ts").CallerIdentity} identity
 * @param {import("../../src/server/output-files.ts").OutputFileDownloadPath} path
 */
export async function guardedOutputFileDownloadForTest(
  query,
  context,
  identity,
  path
) {
  const access = await enforceCallerOperationLimits(
    query,
    identity,
    "output_file_download",
    "Output file download is temporarily unavailable."
  );
  if (!access.ok) {
    return access;
  }
  return outputFileDownloadInTransaction(query, context, identity, path);
}
