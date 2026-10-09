import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS installations (
      id TEXT PRIMARY KEY,
      first_opened_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS touches (
      id INTEGER PRIMARY KEY,
      installation_id TEXT NOT NULL REFERENCES installations(id),
      click_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('campaign', 'referral')),
      source_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      UNIQUE (installation_id, click_id)
    );

    CREATE TABLE IF NOT EXISTS signups (
      user_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL UNIQUE REFERENCES installations(id),
      decision TEXT NOT NULL
    );
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
