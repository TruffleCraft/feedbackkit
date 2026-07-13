-- FeedbackKit schema v1. Migrations are expand/contract (backward-compatible for
-- one release). The worker checks meta.schema_version on boot (ADR-004 invariant 2).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');

-- Project config is a JSON blob (atomic edit, seed-JSON import format = ADR-002).
-- Fields inside carry stable nanoid IDs so per-field stats survive reordering.
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,       -- internal id
  public_key     TEXT NOT NULL UNIQUE,   -- fk_pub_… goes in the snippet
  config         TEXT NOT NULL,          -- JSON (FeedbackConfig)
  config_version INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);

-- Rate limit + LLM daily budget. Atomic upsert (INSERT … ON CONFLICT … +1).
CREATE TABLE counters (
  key          TEXT PRIMARY KEY,   -- e.g. "rl:<project>:<ip>:<hour>" | "llm:<project>:<day>"
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

-- feedbackId idempotency: a dedup hit replays the stored response.
CREATE TABLE dedup (
  feedback_id TEXT PRIMARY KEY,
  response    TEXT NOT NULL,      -- JSON FeedbackResponse
  created_at  INTEGER NOT NULL
);

-- Enum-only funnel events (never content, never IP). Rolled up + pruned by cron.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  name       TEXT NOT NULL,       -- EventName enum
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_events_project_ts ON events (project_id, ts);

-- Attachment index for app-level retention + admin-authed delete (ADR-006).
CREATE TABLE assets (
  key        TEXT PRIMARY KEY,    -- R2 object key
  project_id TEXT NOT NULL,
  feedback_id TEXT NOT NULL,
  kind       TEXT NOT NULL,       -- screenshot | upload
  expires_at INTEGER,             -- NULL = keep until explicit delete
  created_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_assets_expires ON assets (expires_at) WHERE deleted = 0;
CREATE INDEX idx_assets_feedback ON assets (feedback_id);

-- Feedback journey: one row per submission. Holds the payload for issue_failed
-- retry and the final outcome (create-anyway never loses feedback).
CREATE TABLE feedback (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  outcome    TEXT NOT NULL,       -- created | accepted_incomplete | issue_failed | ai-failed | d1-degraded
  payload    TEXT NOT NULL,       -- JSON (normalized), for retry
  issue_url  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_project_ts ON feedback (project_id, created_at);
CREATE INDEX idx_feedback_outcome ON feedback (outcome);
