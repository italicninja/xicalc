import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

let db;

/** Open (and memoize) the SQLite connection, creating the schema if needed. */
export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  migrate(db);
  return db;
}

/** Idempotent column additions for DBs created by an earlier schema. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(ah_price_history)').all();
  if (!cols.some((c) => c.name === 'kind')) {
    db.exec('ALTER TABLE ah_price_history ADD COLUMN kind TEXT');
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,          -- raw snake_case from LSB
      display_name TEXT NOT NULL,          -- humanized for the UI
      stack_size   INTEGER NOT NULL DEFAULT 1,
      auctionable  INTEGER NOT NULL DEFAULT 1,
      base_sell    INTEGER NOT NULL DEFAULT 0  -- NPC resale price (gil)
    );
    CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);

    CREATE TABLE IF NOT EXISTS recipes (
      id              INTEGER PRIMARY KEY,
      result_item_id  INTEGER NOT NULL,
      result_name     TEXT NOT NULL,
      craft           TEXT NOT NULL,        -- primary (highest) craft
      cap             INTEGER NOT NULL,     -- primary craft skill cap
      crystal_item_id INTEGER NOT NULL,
      crystal         TEXT NOT NULL,        -- element name, e.g. "Wind"
      yield           INTEGER NOT NULL DEFAULT 1,
      hq1_yield       INTEGER,
      hq2_yield       INTEGER,
      hq3_yield       INTEGER,
      desynth         INTEGER NOT NULL DEFAULT 0,
      content_tag     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recipes_craft ON recipes(craft);
    CREATE INDEX IF NOT EXISTS idx_recipes_result_name ON recipes(result_name);

    CREATE TABLE IF NOT EXISTS recipe_skills (
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      craft     TEXT NOT NULL,
      cap       INTEGER NOT NULL,
      PRIMARY KEY (recipe_id, craft)
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      item_id   INTEGER NOT NULL,
      qty       INTEGER NOT NULL,
      slot      INTEGER NOT NULL,    -- first slot the ingredient appeared in
      PRIMARY KEY (recipe_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ringredients_item ON recipe_ingredients(item_id);

    CREATE TABLE IF NOT EXISTS ah_prices (
      item_id      INTEGER NOT NULL,
      source       TEXT NOT NULL,        -- e.g. "psxi"
      median_price INTEGER,
      last_price   INTEGER,
      stock        INTEGER,
      sales_24h    INTEGER,
      fetched_at   TEXT NOT NULL,        -- ISO timestamp
      PRIMARY KEY (item_id, source)
    );

    CREATE TABLE IF NOT EXISTS ah_price_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL,
      source     TEXT NOT NULL,
      price      INTEGER,
      stock      INTEGER,
      kind       TEXT,            -- 'listing' (current ask) | 'sale' (transaction)
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_item ON ah_price_history(item_id, fetched_at);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/** True when the recipe set has not been populated yet. */
export function isEmpty() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM recipes').get();
  return row.n === 0;
}

export function setMeta(key, value) {
  getDb()
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, String(value));
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
