import type { DatabaseSync } from "node:sqlite";

/**
 * Run `work` inside one `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws.
 *
 * `IMMEDIATE` takes the write lock up front, so a read-then-write inside `work` cannot be interleaved
 * with another writer of the same file. The rollback is guarded because a failed `COMMIT` may already
 * have ended the transaction.
 */
export function transact<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
