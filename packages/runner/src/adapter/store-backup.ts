/**
 * A copy of an office's Pi Durable store before Pi migrates it.
 *
 * Pi Durable 1.4 and later migrate a SQLite store written by 1.3.0 or earlier (schema version 1) to
 * their own schema when they open it, and an Office Hum built on 1.3.0 can never open the migrated
 * file again. So before the adapter lets Pi open a store, it looks at the store's schema version, and
 * if Pi would migrate it, takes a copy first with SQLite's own online backup (`node:sqlite`'s
 * `backup`), which is consistent whatever the write-ahead log holds. The copy sits beside the store,
 * named for the schema it holds and the time it was taken, and is the only way back to 1.3.0.
 *
 * Once: a store already on the current schema is not copied again. Never over an existing file. And
 * never without the copy: when it cannot be taken, the office refuses to open, and nothing is migrated.
 */
import { existsSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

/** The table Pi Durable records its SQLite schema version in. */
const SCHEMA_TABLE = "durable_schema";

/** The schema version a store at `path` is on: `undefined` when there is no store there yet. */
export function storeSchemaVersion(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(SCHEMA_TABLE);
    if (table === undefined) return undefined;
    const row = database.prepare(`SELECT MAX(version) AS version FROM ${SCHEMA_TABLE}`).get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? undefined;
  } finally {
    database.close();
  }
}

/** Where the copy of the store at `path`, on `schema`, taken at `at`, goes. */
export function storeBackupPath(path: string, schema: number, at: Date): string {
  const stamp = at.toISOString().replaceAll(":", "-");
  return `${path}.pi-durable-schema-${schema}.${stamp}.backup.sqlite`;
}

/**
 * Copy the store at `path` if Pi Durable is about to migrate it, and say where the copy is. Returns
 * the copy's path, or `undefined` when nothing needed copying. Throws, copying nothing over anything,
 * when the copy cannot be taken or checked; the caller must not open the store then.
 */
export async function backUpBeforeMigration(
  path: string,
  log: (line: string) => void,
  now: () => Date = () => new Date(),
): Promise<string | undefined> {
  let schema: number | undefined;
  try {
    schema = storeSchemaVersion(path);
  } catch (error) {
    throw new Error(
      `Office Hum did not open ${path}: it could not read the store's schema version to decide whether to back it up before Pi Durable migrates it (${String(error)}). Nothing was changed.`,
    );
  }
  if (schema === undefined || schema >= CURRENT_SQLITE_SCHEMA_VERSION) return undefined;
  const target = storeBackupPath(path, schema, now());
  if (existsSync(target)) {
    throw new Error(
      `Office Hum did not open ${path}: a backup is already at ${target}, and it is never overwritten. Move it aside and start the office again. Nothing was migrated.`,
    );
  }
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    await backup(source, target);
  } catch (error) {
    throw new Error(
      `Office Hum did not open ${path}: Pi Durable migrates this store to its new format when it opens it, and the backup that must come first failed (${String(error)}). Nothing was migrated; free space or fix the directory's permissions and start the office again.`,
    );
  } finally {
    source.close();
  }
  // The copy must be the store as it was: on the old schema, and readable.
  let copied: number | undefined;
  try {
    copied = storeSchemaVersion(target);
  } catch (error) {
    copied = undefined;
    log(`The backup at ${target} could not be read back: ${String(error)}`);
  }
  if (copied !== schema) {
    throw new Error(
      `Office Hum did not open ${path}: the backup at ${target} does not hold the store's schema version ${schema}. Nothing was migrated.`,
    );
  }
  log(
    `Before Pi Durable migrates ${path} to its new format, a copy was saved to ${target}. It is the only way back to an Office Hum release built on Pi Durable 1.3: restoring it loses everything done since.`,
  );
  return target;
}
