import { runProductTransaction } from "../src/server/database.ts";
import { deriveReviewSearchTextForAccount } from "../src/server/review-search-text.ts";
import { cleanupAccountTargetsStatement } from "../src/server/scheduled.ts";

const connectionString = process.env.DATABASE_APP_ROLE_URL;
if (!connectionString) throw new Error("DATABASE_APP_ROLE_URL is required.");
const requestId = `review-text-${crypto.randomUUID()}`;
const accounts = await runProductTransaction(
  connectionString,
  { authSurface: "cleanup", requestId },
  async (query) =>
    (await query<{ account_id: string }>(cleanupAccountTargetsStatement())).rows
);
const failures: unknown[] = [];
for (const account of accounts) {
  try {
    await deriveReviewSearchTextForAccount({
      connectionString,
      requestId,
      accountId: account.account_id
    });
  } catch (error) {
    console.error(
      `Review text derivation failed for account ${account.account_id}`
    );
    failures.push(error);
  }
}
if (failures.length)
  throw new AggregateError(
    failures,
    "Review text derivation failed; committed batches are retained."
  );
