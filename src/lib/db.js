// SQLite storage via Node's built-in node:sqlite (no native dependency).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,              -- rss | google_news | youtube | twitch | reddit | bluesky | manual
  medium TEXT NOT NULL DEFAULT 'web',-- web | video | stream | social | print | broadcast | podcast
  platform TEXT,                     -- for manual/social: tiktok, instagram, x, ...
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  author TEXT,
  outlet TEXT,
  outlet_domain TEXT,
  tier TEXT,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  lang TEXT,
  type TEXT,                         -- review | preview | news | feature | interview | video | stream | social | listicle | other
  sentiment TEXT,                    -- positive | neutral | negative | mixed
  relevant INTEGER,                  -- 1 relevant, 0 not relevant, NULL pending
  relevance_confidence REAL,
  relevance_reason TEXT,
  classified_by TEXT,                -- model id, 'heuristic' or 'manual'
  summary_en TEXT,
  summary_fr TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  audience INTEGER,                  -- subscribers / followers of the author or channel
  thumbnail TEXT,
  duplicate_of INTEGER REFERENCES hits(id),
  manual_override INTEGER NOT NULL DEFAULT 0,
  alerted_at TEXT,
  raw TEXT,
  UNIQUE(project_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_hits_project_date ON hits(project_id, published_at);
CREATE INDEX IF NOT EXISTS idx_hits_pending ON hits(relevant) WHERE relevant IS NULL;

CREATE TABLE IF NOT EXISTS streams (
  stream_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT,
  user_login TEXT,
  user_name TEXT,
  title TEXT,
  language TEXT,
  started_at TEXT,
  last_seen_at TEXT,
  ended_at TEXT,
  peak_viewers INTEGER DEFAULT 0,
  viewer_sum INTEGER DEFAULT 0,
  samples INTEGER DEFAULT 0,
  followers INTEGER,
  thumbnail TEXT,
  alerted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_streams_project ON streams(project_id, started_at);

CREATE TABLE IF NOT EXISTS poll_state (
  key TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_status TEXT,
  last_message TEXT
);

CREATE TABLE IF NOT EXISTS usage_log (
  day TEXT NOT NULL,
  api TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, api)
);
`;

let db;

export function openDb(file = process.env.DB_PATH || "data/coverage.db") {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  db?.close();
  db = undefined;
}

const HIT_COLUMNS = [
  "project_id", "source", "medium", "platform", "url", "canonical_url", "title", "snippet", "author", "outlet",
  "outlet_domain", "tier", "published_at", "discovered_at", "lang", "type", "sentiment", "relevant",
  "relevance_confidence", "relevance_reason", "classified_by", "summary_en", "summary_fr", "views", "likes",
  "comments", "audience", "thumbnail", "duplicate_of", "manual_override", "raw",
];

/** Insert a hit if new. Returns the new row id, or null if it already existed (metrics are refreshed). */
export function insertHit(hit) {
  const d = openDb();
  const row = { discovered_at: new Date().toISOString(), medium: "web", manual_override: 0, ...hit };
  if (row.raw && typeof row.raw !== "string") row.raw = JSON.stringify(row.raw);
  const existing = d.prepare("SELECT id FROM hits WHERE project_id = ? AND canonical_url = ?").get(row.project_id, row.canonical_url);
  if (existing) {
    // refresh engagement metrics on re-sighting (e.g. YouTube view counts)
    d.prepare(
      "UPDATE hits SET views = COALESCE(?, views), likes = COALESCE(?, likes), comments = COALESCE(?, comments), audience = COALESCE(?, audience) WHERE id = ?",
    ).run(row.views ?? null, row.likes ?? null, row.comments ?? null, row.audience ?? null, existing.id);
    return null;
  }
  const cols = HIT_COLUMNS.filter((c) => row[c] !== undefined);
  const info = d
    .prepare(`INSERT INTO hits (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => (typeof row[c] === "boolean" ? Number(row[c]) : row[c] ?? null)));
  return Number(info.lastInsertRowid);
}

export function updateHit(id, fields) {
  const keys = Object.keys(fields).filter((k) => HIT_COLUMNS.includes(k) || k === "alerted_at");
  if (!keys.length) return;
  openDb()
    .prepare(`UPDATE hits SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => (typeof fields[k] === "boolean" ? Number(fields[k]) : fields[k] ?? null)), id);
}

export function getHit(id) {
  return openDb().prepare("SELECT * FROM hits WHERE id = ?").get(id);
}

export function queryHits({ projectId, from, to, includeIrrelevant = false, includeDuplicates = true, limit = 5000 } = {}) {
  const where = [];
  const args = [];
  if (projectId) where.push("project_id = ?"), args.push(projectId);
  if (from) where.push("COALESCE(published_at, discovered_at) >= ?"), args.push(from);
  if (to) where.push("COALESCE(published_at, discovered_at) <= ?"), args.push(to);
  if (!includeIrrelevant) where.push("relevant = 1");
  if (!includeDuplicates) where.push("duplicate_of IS NULL");
  const sql = `SELECT * FROM hits ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(published_at, discovered_at) DESC LIMIT ?`;
  return openDb().prepare(sql).all(...args, limit);
}

export function queryStreams({ projectId, from, to } = {}) {
  const where = [];
  const args = [];
  if (projectId) where.push("project_id = ?"), args.push(projectId);
  if (from) where.push("started_at >= ?"), args.push(from);
  if (to) where.push("started_at <= ?"), args.push(to);
  return openDb()
    .prepare(`SELECT * FROM streams ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC`)
    .all(...args);
}

export function shouldRun(key, everyMinutes, force = false) {
  if (force) return true;
  const row = openDb().prepare("SELECT last_run_at FROM poll_state WHERE key = ?").get(key);
  if (!row?.last_run_at) return true;
  // 2-minute grace so a 30-min cron doesn't drift past a 60-min interval
  return Date.now() - Date.parse(row.last_run_at) >= (everyMinutes - 2) * 60_000;
}

export function markRun(key, status = "ok", message = "") {
  openDb()
    .prepare(
      `INSERT INTO poll_state (key, last_run_at, last_status, last_message) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status, last_message = excluded.last_message`,
    )
    .run(key, new Date().toISOString(), status, String(message).slice(0, 500));
}

export function pollStates() {
  return openDb().prepare("SELECT * FROM poll_state ORDER BY key").all();
}

export function addUsage(api, units) {
  const day = new Date().toISOString().slice(0, 10);
  openDb()
    .prepare("INSERT INTO usage_log (day, api, units) VALUES (?, ?, ?) ON CONFLICT(day, api) DO UPDATE SET units = units + excluded.units")
    .run(day, api, units);
}

export function usageToday(api) {
  const day = new Date().toISOString().slice(0, 10);
  return openDb().prepare("SELECT units FROM usage_log WHERE day = ? AND api = ?").get(day, api)?.units ?? 0;
}
