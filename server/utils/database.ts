import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from '../db/schema'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function useDatabase() {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || './data/ypad.db'

    const dir = dirname(dbPath)
    try { mkdirSync(dir, { recursive: true }) } catch {}

    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    db = drizzle(sqlite, { schema })

    // Run schema push (create tables if they don't exist)
    // In production, use drizzle-kit migrations instead
    runMigrations(sqlite)
  }
  return db
}

function runMigrations(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id   TEXT UNIQUE,
      google_id   TEXT UNIQUE,
      login       TEXT,
      name        TEXT NOT NULL,
      email       TEXT,
      avatar_url  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id       TEXT NOT NULL UNIQUE,
      owner_id     INTEGER REFERENCES users(id),
      title        TEXT NOT NULL DEFAULT 'Untitled',
      access_mode  TEXT NOT NULL DEFAULT 'open-edit',
      password_hash TEXT,
      size_bytes   INTEGER DEFAULT 0,
      word_count   INTEGER DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_active  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS document_shares (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id       TEXT NOT NULL REFERENCES documents(doc_id),
      user_id      INTEGER NOT NULL REFERENCES users(id),
      role         TEXT NOT NULL DEFAULT 'editor',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(doc_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL UNIQUE,
      owner_id     INTEGER NOT NULL REFERENCES users(id),
      name         TEXT NOT NULL DEFAULT 'My Workspace',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS workspace_documents (
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
      doc_id       TEXT NOT NULL REFERENCES documents(doc_id),
      added_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (workspace_id, doc_id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id        TEXT NOT NULL REFERENCES documents(doc_id),
      user_name     TEXT,
      action        TEXT NOT NULL,
      word_count    INTEGER,
      lines_added   INTEGER,
      lines_removed INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
    CREATE INDEX IF NOT EXISTS idx_documents_last_active ON documents(last_active);
    CREATE INDEX IF NOT EXISTS idx_workspace_docs ON workspace_documents(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_activity_doc ON activity_log(doc_id, created_at);
  `)

  // Additive column migrations for tables that may pre-date them. ALTER TABLE ADD
  // COLUMN isn't idempotent in SQLite, so gate on PRAGMA table_info.
  addColumnIfMissing(sqlite, 'activity_log', 'lines_added', 'INTEGER')
  addColumnIfMissing(sqlite, 'activity_log', 'lines_removed', 'INTEGER')
}

function addColumnIfMissing(sqlite: Database.Database, table: string, column: string, decl: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}
