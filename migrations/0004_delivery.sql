-- FeedbackKit schema v4 (#109): delivery model (issue | project | local). Expand-only:
-- every column is nullable or has a default, so the previous release keeps
-- inserting rows without them and keeps working on this schema.

-- Where the report was meant to go, resolved when it was processed. NULL = not
-- known (rows from before v4 whose destination cannot be proven).
ALTER TABLE feedback ADD COLUMN delivery TEXT;
-- pending | delivered | failed | unknown (issue and project delivery only).
ALTER TABLE feedback ADD COLUMN delivery_state TEXT;
-- GitHub Project draft issue (delivery = 'project').
ALTER TABLE feedback ADD COLUMN project_item_id TEXT;
ALTER TABLE feedback ADD COLUMN project_url TEXT;
-- Local inbox (delivery = 'local'): open | done | dismissed, one operator note.
ALTER TABLE feedback ADD COLUMN disposition TEXT NOT NULL DEFAULT 'open';
ALTER TABLE feedback ADD COLUMN note TEXT;
ALTER TABLE feedback ADD COLUMN handled_at INTEGER;
-- Delivery claim: a retry sets a token and an expiry so two cannot run at once.
ALTER TABLE feedback ADD COLUMN claim_token TEXT;
ALTER TABLE feedback ADD COLUMN claim_until INTEGER;
-- The delivery attempt written into the issue or draft as a marker, so a retry
-- after an uncertain outcome can find it instead of creating a second one.
ALTER TABLE feedback ADD COLUMN attempt_id TEXT;
-- JSON array of skipped Project fields and similar non-fatal notes.
ALTER TABLE feedback ADD COLUMN delivery_warnings TEXT;
-- Test reports from the admin; left out of the funnel and "new in 7 days".
ALTER TABLE feedback ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

-- Conservative backfill: only rows that provably went to (or were meant for) an
-- issue get a destination. Rows without an issue stay NULL: the template that
-- made them may have changed since, so their destination is not proven.
UPDATE feedback SET delivery = 'issue', delivery_state = 'delivered' WHERE delivery IS NULL AND issue_url IS NOT NULL;
UPDATE feedback SET delivery = 'issue', delivery_state = 'failed' WHERE delivery IS NULL AND issue_url IS NULL AND outcome = 'issue_failed';

CREATE INDEX idx_feedback_project_delivery ON feedback (project_id, delivery, disposition, created_at);

UPDATE meta SET value = '4' WHERE key = 'schema_version';
