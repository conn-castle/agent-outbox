import assert from "node:assert/strict";

/**
 * @typedef {import("../../src/server/database.ts").ProductTransactionContext} ProductTransactionContext
 * @typedef {import("../../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

/**
 * @param {QueryResultRow[]} rows
 * @returns {import("pg").QueryResult<QueryResultRow>}
 */
export function queryResult(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

/**
 * Records each statement in `calls`, except those `isUnrecorded` matches,
 * which get no rows, and resolves rows from `resolver(statement, callNumber)`.
 *
 * @param {(statement: TransactionContextStatement, callNumber: number) => QueryResultRow[]} resolver
 * @param {(statement: TransactionContextStatement) => boolean} [isUnrecorded]
 * @returns {MockProductTransactionQuery}
 */
function recordingQuery(resolver, isUnrecorded = () => false) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /** @param {TransactionContextStatement} statement */
  const query = async (statement) => {
    if (isUnrecorded(statement)) {
      return queryResult([]);
    }
    calls.push(statement);
    return queryResult(resolver(statement, calls.length));
  };
  const typed = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typed.calls = calls;
  return typed;
}

/**
 * Returns `rowsByCall[n]` for the nth statement, or no rows past the end.
 *
 * @param {QueryResultRow[][]} rowsByCall
 * @returns {MockProductTransactionQuery}
 */
export function fakeQuery(rowsByCall) {
  return recordingQuery(
    (_statement, callNumber) => rowsByCall[callNumber - 1] ?? []
  );
}

/**
 * Resolves rows from `resolver(statement, callNumber)`. Savepoint control
 * statements get no rows and are not recorded: this fake cannot model
 * savepoint recovery, so live database tests prove that behavior.
 *
 * @param {(statement: TransactionContextStatement, callNumber: number) => QueryResultRow[]} resolver
 * @returns {MockProductTransactionQuery}
 */
export function fakeSavepointAwareQuery(resolver) {
  return recordingQuery(resolver, (statement) =>
    /^\s*(savepoint|release savepoint|rollback to savepoint) /.test(
      statement.sql
    )
  );
}

/**
 * Runs each product transaction on the next of `queries`, failing when none
 * remain, and records each transaction context.
 *
 * @param {MockProductTransactionQuery[]} queries
 * @returns {{ runProductTransaction: typeof import("../../src/server/database.ts").runProductTransaction, contexts: ProductTransactionContext[] }}
 */
export function fakeTransactionRunner(queries) {
  const pendingQueries = [...queries];
  /** @type {ProductTransactionContext[]} */
  const contexts = [];
  /** @type {typeof import("../../src/server/database.ts").runProductTransaction} */
  const runProductTransaction = async (
    _connectionString,
    context,
    callback
  ) => {
    contexts.push(context);
    const query = pendingQueries.shift();
    if (!query) {
      assert.fail("unexpected product transaction");
    }
    return await callback(query);
  };

  return { runProductTransaction, contexts };
}
