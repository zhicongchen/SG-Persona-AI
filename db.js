import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// =========================
// Database setup
// =========================
// The SQLite file lives in ./data/ (gitignored).
// DATA_DIR can be overridden via .env, e.g. for tests.

export const DATA_DIR = process.env.DATA_DIR || './data';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'sg-persona.db'));

// WAL allows concurrent reads while writing; FKs are off by default in SQLite
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// =========================
// Schema
// =========================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL,
    title      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS persona_evolution_runs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id         TEXT NOT NULL,
    conversation_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    through_message_id INTEGER NOT NULL,
    should_evolve      INTEGER NOT NULL CHECK (should_evolve IN (0, 1)),
    reason             TEXT NOT NULL,
    decision_json      TEXT NOT NULL,
    applied_patch_json TEXT NOT NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, persona_id, conversation_id, through_message_id)
  );

  CREATE TABLE IF NOT EXISTS persona_interactions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id         TEXT NOT NULL,
    conversation_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    interaction_number INTEGER NOT NULL,
    through_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    summary            TEXT NOT NULL,
    memory_ids_json    TEXT NOT NULL DEFAULT '[]',
    should_evolve      INTEGER NOT NULL CHECK (should_evolve IN (0, 1)),
    reason             TEXT NOT NULL,
    assessment_json    TEXT NOT NULL DEFAULT '{}',
    decision_json      TEXT NOT NULL,
    applied_patch_json TEXT NOT NULL,
    state_snapshot_json  TEXT,
    memory_snapshot_json TEXT,
    snapshot_quality     TEXT CHECK (snapshot_quality IN ('exact', 'reconstructed')),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (conversation_id, through_message_id)
  );

  CREATE TABLE IF NOT EXISTS persona_restore_events (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id               TEXT NOT NULL,
    conversation_id          INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    target_interaction_id    INTEGER REFERENCES persona_interactions(id) ON DELETE SET NULL,
    target_interaction_number INTEGER,
    target_kind              TEXT NOT NULL CHECK (target_kind IN ('initial', 'interaction')),
    previous_state_json      TEXT NOT NULL,
    previous_memory_json     TEXT NOT NULL,
    restored_state_json      TEXT NOT NULL,
    restored_memory_json     TEXT NOT NULL,
    created_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS persona_relationship_settings (
    user_id                       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id                    TEXT NOT NULL,
    stranger_to_acquaintance      INTEGER NOT NULL DEFAULT 1,
    acquaintance_to_friend        INTEGER NOT NULL DEFAULT 10,
    friend_to_close_friend        INTEGER NOT NULL DEFAULT 0,
    close_friend_to_intimate      INTEGER NOT NULL DEFAULT 0,
    updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, persona_id),
    CHECK (stranger_to_acquaintance >= 0),
    CHECK (acquaintance_to_friend >= 0),
    CHECK (friend_to_close_friend >= 0),
    CHECK (close_friend_to_intimate >= 0)
  );

  CREATE TABLE IF NOT EXISTS survey_respondents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id       TEXT NOT NULL UNIQUE,
    prolific_pid      TEXT,
    age               TEXT,
    gender            TEXT,
    education         TEXT,
    occupation        TEXT,
    marital_status    TEXT,
    income_band       TEXT,
    housing_type      TEXT,
    residency_status  TEXT,
    ethnicity         TEXT,
    raw_json          TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS survey_personas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    respondent_id  INTEGER NOT NULL REFERENCES survey_respondents(id) ON DELETE CASCADE,
    slug           TEXT NOT NULL UNIQUE,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_user_persona
    ON conversations (user_id, persona_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages (conversation_id, id);

  CREATE INDEX IF NOT EXISTS idx_evolution_runs_context
    ON persona_evolution_runs (user_id, persona_id, conversation_id, through_message_id DESC);

  CREATE INDEX IF NOT EXISTS idx_persona_interactions_context
    ON persona_interactions (user_id, persona_id, conversation_id, through_message_id DESC);

  CREATE INDEX IF NOT EXISTS idx_persona_restore_events_context
    ON persona_restore_events (user_id, persona_id, id DESC);
`);

// Lightweight migration for databases created before two-pass evolution.
const interactionColumns = new Set(
  db.pragma('table_info(persona_interactions)').map(column => column.name)
);
if (!interactionColumns.has('assessment_json')) {
  db.exec("ALTER TABLE persona_interactions ADD COLUMN assessment_json TEXT NOT NULL DEFAULT '{}'");
}
if (!interactionColumns.has('state_snapshot_json')) {
  db.exec('ALTER TABLE persona_interactions ADD COLUMN state_snapshot_json TEXT');
}
if (!interactionColumns.has('memory_snapshot_json')) {
  db.exec('ALTER TABLE persona_interactions ADD COLUMN memory_snapshot_json TEXT');
}
if (!interactionColumns.has('snapshot_quality')) {
  db.exec('ALTER TABLE persona_interactions ADD COLUMN snapshot_quality TEXT');
}

console.log(`SQLite database ready at ${path.join(DATA_DIR, 'sg-persona.db')}`);

export default db;
