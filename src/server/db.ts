import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.ts'

/**
 * Storage.
 *
 * SQLite via Node's built-in `node:sqlite` -- a real database that is just one file
 * on disk (data/gre.db). No server, no accounts, nothing to install: the module ships
 * inside Node 24.
 *
 * Times are stored as ISO 8601 UTC strings. They sort correctly as plain text, and
 * you can read the table with your own eyes when something looks wrong.
 */

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new DatabaseSync(config.dbPath)

// Write-ahead logging: lets the background generator write new questions while the
// drill session is reading, instead of the two blocking each other.
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS questions (
  id             TEXT PRIMARY KEY,
  section        TEXT NOT NULL,
  subtopic       TEXT NOT NULL,
  format         TEXT NOT NULL,
  difficulty     INTEGER NOT NULL,

  -- The question itself, shape depending on format. JSON so formats can differ
  -- without a table per format.
  payload        TEXT NOT NULL,
  -- Correct answer, shape depending on format.
  answer         TEXT NOT NULL,
  explanation    TEXT NOT NULL,
  -- Arithmetic expression that must evaluate to the answer (quant only).
  check_expr     TEXT,

  -- 'draft' until both gates pass, then 'verified' or 'rejected'.
  status         TEXT NOT NULL DEFAULT 'draft',
  reject_reason  TEXT,
  verifier_note  TEXT,

  model          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  -- Set the first time this question is served, so it is never served twice as new.
  first_served_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_pool
  ON questions (status, section, subtopic, difficulty, first_served_at);

CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL REFERENCES questions(id),
  mode        TEXT NOT NULL,            -- drill | review | mock
  response    TEXT NOT NULL,            -- what you picked or typed, JSON
  correct     INTEGER NOT NULL,         -- 0 or 1
  seconds     REAL NOT NULL,
  error_tag   TEXT,                     -- why it went wrong, from src/content/errors.ts
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts (question_id);
CREATE INDEX IF NOT EXISTS idx_attempts_time ON attempts (created_at);

-- One row per subtopic. alpha/beta are the parameters of a Beta distribution: a
-- running estimate of your accuracy that carries its own uncertainty, so three
-- questions do not look like settled fact.
CREATE TABLE IF NOT EXISTS mastery (
  subtopic   TEXT PRIMARY KEY,
  alpha      REAL NOT NULL DEFAULT 2.0,
  beta       REAL NOT NULL DEFAULT 2.0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- Spaced repetition state for questions you got wrong (SM-2).
CREATE TABLE IF NOT EXISTS review_schedule (
  question_id   TEXT PRIMARY KEY REFERENCES questions(id),
  due_at        TEXT NOT NULL,
  interval_days REAL NOT NULL,
  ease          REAL NOT NULL DEFAULT 2.5,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_review_due ON review_schedule (due_at);

-- Every Claude call, so the daily cap is enforceable and usage is visible.
CREATE TABLE IF NOT EXISTS call_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose       TEXT NOT NULL,          -- generate | verify | coach | review
  model         TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_log_time ON call_log (created_at);

-- Personalised note explaining one specific wrong answer. Cached so re-reviewing a
-- question costs nothing.
CREATE TABLE IF NOT EXISTS coaching (
  question_id  TEXT NOT NULL REFERENCES questions(id),
  response_key TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (question_id, response_key)
);

CREATE TABLE IF NOT EXISTS vocab (
  word         TEXT PRIMARY KEY,
  definition   TEXT NOT NULL,
  seen_in      TEXT,
  due_at       TEXT NOT NULL,
  interval_days REAL NOT NULL DEFAULT 0,
  ease         REAL NOT NULL DEFAULT 2.5,
  reps         INTEGER NOT NULL DEFAULT 0,
  lapses       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A printed practice sheet. The running order is decided once, when the sheet is
-- generated, and stored here so the screen serves exactly what is on the paper --
-- selection is weighted-random, so re-deciding it later would not agree.
CREATE TABLE IF NOT EXISTS worksheets (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  pages        INTEGER NOT NULL,
  -- Ordered JSON array of question ids.
  question_ids TEXT NOT NULL,
  html_path    TEXT,
  -- Set once the sheet has been worked through on screen.
  finished_at  TEXT
);
`)

export function nowIso(): string {
  return new Date().toISOString()
}

/** Calendar day in local time, e.g. "2026-08-22". The cap is a per-day budget and
 *  should roll over at your midnight, not UTC's. */
export function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const insertCall = db.prepare(`
  INSERT INTO call_log (purpose, model, ok, input_tokens, output_tokens, cache_tokens,
                        cost_usd, duration_ms, error, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export type CallRecord = {
  purpose: string
  model: string
  ok: boolean
  inputTokens?: number
  outputTokens?: number
  cacheTokens?: number
  costUsd?: number
  durationMs?: number
  error?: string
}

export function recordCall(r: CallRecord): void {
  insertCall.run(
    r.purpose,
    r.model,
    r.ok ? 1 : 0,
    r.inputTokens ?? 0,
    r.outputTokens ?? 0,
    r.cacheTokens ?? 0,
    r.costUsd ?? 0,
    r.durationMs ?? 0,
    r.error ?? null,
    nowIso(),
  )
}

/**
 * How many Claude calls have been made today, counting failures.
 *
 * Failures count deliberately: a call that errored still consumed quota, and a bug
 * that fails in a loop is exactly what the cap exists to stop.
 */
export function callsToday(): number {
  // created_at is an ISO UTC string, so a plain text comparison against the UTC
  // instant of your local midnight gives "since the start of today, where you are".
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM call_log WHERE created_at >= ?')
    .get(midnight.toISOString()) as { n: number } | undefined
  return row?.n ?? 0
}

export type BudgetState = {
  used: number
  limit: number
  remaining: number
  exhausted: boolean
}

export function budget(): BudgetState {
  const used = callsToday()
  const limit = config.maxCallsPerDay
  return { used, limit, remaining: Math.max(0, limit - used), exhausted: used >= limit }
}

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  )
}
