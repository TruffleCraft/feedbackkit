-- FeedbackKit schema v2 (P2 admin API). Expand-only: every column is nullable or
-- has a default, so the previous release keeps inserting its six columns and
-- keeps working on this schema (RELEASES.md, one D1 for both channels).

-- What the gateway knew when it processed the submission. Written once and never
-- updated by a later config change (#70): type and title as rendered, the LLM
-- provider/model and config version that were configured at that moment.
ALTER TABLE feedback ADD COLUMN type TEXT;
ALTER TABLE feedback ADD COLUMN title TEXT;
ALTER TABLE feedback ADD COLUMN llm_provider TEXT;
ALTER TABLE feedback ADD COLUMN llm_model TEXT;
ALTER TABLE feedback ADD COLUMN config_version INTEGER;
ALTER TABLE feedback ADD COLUMN updated_at INTEGER;

-- Admin retry of issue_failed rows. issue_draft holds the rendered issue as JSON
-- ({title, body, labels, repo}) so a retry creates it without calling the LLM.
ALTER TABLE feedback ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback ADD COLUMN last_error TEXT;
ALTER TABLE feedback ADD COLUMN issue_draft TEXT;

-- Feedback history filtered by outcome, newest first (keyset on created_at, id).
CREATE INDEX idx_feedback_project_outcome_ts ON feedback (project_id, outcome, created_at);

UPDATE meta SET value = '2' WHERE key = 'schema_version';
