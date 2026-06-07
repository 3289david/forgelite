// Uses Node.js built-in SQLite (Node 22+) — no native compilation needed
import { DatabaseSync, StatementSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

// Wrapper that auto-disables bigint return values on every prepared statement
class Db {
  private inner: DatabaseSync;

  constructor(location: string) {
    this.inner = new DatabaseSync(location, { enableForeignKeyConstraints: true });
    this.inner.exec('PRAGMA journal_mode = WAL');
  }

  exec(sql: string): void { this.inner.exec(sql); }

  prepare(sql: string): StatementSync {
    const stmt = this.inner.prepare(sql);
    stmt.setReadBigInts(false);
    return stmt;
  }
}

let _db: Db | null = null;

export function getDb(): Db {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new Db(config.dbPath);
  applySchema(_db);
  return _db;
}

function applySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      bio         TEXT NOT NULL DEFAULT '',
      website     TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL COLLATE NOCASE,
      description    TEXT NOT NULL DEFAULT '',
      is_private     INTEGER NOT NULL DEFAULT 0,
      fork_of        INTEGER REFERENCES repositories(id) ON DELETE SET NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      website        TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, name)
    );

    CREATE TABLE IF NOT EXISTS stars (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repo_id    INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, following_id),
      CHECK (follower_id != following_id)
    );

    CREATE TABLE IF NOT EXISTS issues (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id    INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      number     INTEGER NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      author_id  INTEGER NOT NULL REFERENCES users(id),
      status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, number)
    );

    CREATE TABLE IF NOT EXISTS issue_comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author_id  INTEGER NOT NULL REFERENCES users(id),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pull_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id      INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      number       INTEGER NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL DEFAULT '',
      author_id    INTEGER NOT NULL REFERENCES users(id),
      head_repo_id INTEGER REFERENCES repositories(id) ON DELETE SET NULL,
      head_branch  TEXT NOT NULL,
      base_branch  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','merged')),
      merged_at    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, number)
    );

    CREATE TABLE IF NOT EXISTS pr_comments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id       INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
      author_id   INTEGER NOT NULL REFERENCES users(id),
      body        TEXT NOT NULL,
      file_path   TEXT,
      line_number INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS access_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_repos_owner ON repositories(owner_id);
    CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_id);
    CREATE INDEX IF NOT EXISTS idx_prs_repo    ON pull_requests(repo_id);
  `);
}

export interface DbUser {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  bio: string;
  website: string;
  location: string;
  created_at: string;
}

export interface DbRepo {
  id: number;
  owner_id: number;
  name: string;
  description: string;
  is_private: number;
  fork_of: number | null;
  default_branch: string;
  website: string;
  created_at: string;
  updated_at: string;
}

export interface DbIssue {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string;
  author_id: number;
  status: 'open' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface DbPullRequest {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string;
  author_id: number;
  head_repo_id: number | null;
  head_branch: string;
  base_branch: string;
  status: 'open' | 'closed' | 'merged';
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}
