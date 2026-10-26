/**
 * The board, as other directories' tests may open and seed it.
 *
 * `openBoard` and the file name it opens are deliberately private to this directory, and a colocated
 * test in `board.test.ts` enforces that by scanning for both strings everywhere else under
 * `packages/` and `agents/`. The relay's tests still need a real board, so they come through here
 * instead of naming the factory themselves. This module is the one sanctioned door, and both
 * functions are thin: the guard's point is that the board file has one writer, not that no test may
 * construct one.
 *
 * `seedPerson` exists because migration 1 ships the `people` table with no writer — a person is
 * managed by whoever owns the office's people, which is not this issue — and the relay's person
 * fallback still needs a row to route to. A test seeds one the way the office eventually will.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Board, openBoard } from "./index.js";
import { applyMigrations } from "./migrations.js";

/** Open a board over `file`; see `openBoard` for the storage and migration rules. */
export function createWorkboard(file: string): Board {
  return openBoard(file);
}

/** Add one person to the board at `file`, creating the file and its schema when absent. */
export function seedPerson(file: string, id: string, name: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    applyMigrations(database);
    database
      .prepare("INSERT OR IGNORE INTO people (id, name, roles) VALUES (?, ?, '[]')")
      .run(id, name);
  } finally {
    database.close();
  }
}
