-- FeedbackKit schema v3 (#108): one submission identity per project. Expand-only:
-- the column is nullable, so the previous release keeps inserting rows without it
-- (NULLs never collide in a UNIQUE index) and keeps working on this schema.

-- The widget's feedbackId. Assets are indexed by it (assets.feedback_id), rows by
-- a server id; this column joins them for retention and erasure, and the unique
-- index makes a repeated submission land on the row that already exists.
ALTER TABLE feedback ADD COLUMN client_feedback_id TEXT;

-- Backfill from the stored payload. Before v3 a resent issue_failed submission
-- could create a second row with the same feedbackId; only the newest row of each
-- (project, feedbackId) gets the id so the unique index below can be built.
UPDATE feedback
SET client_feedback_id = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.feedbackId') END
WHERE client_feedback_id IS NULL
  AND id = (
    SELECT f2.id FROM feedback AS f2
    WHERE f2.project_id = feedback.project_id
      AND CASE WHEN json_valid(f2.payload) THEN json_extract(f2.payload, '$.feedbackId') END
        = CASE WHEN json_valid(feedback.payload) THEN json_extract(feedback.payload, '$.feedbackId') END
    ORDER BY f2.created_at DESC, f2.id DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX idx_feedback_project_client ON feedback (project_id, client_feedback_id);

-- Retention notice: unhandled (no issue) rows per project by age.
CREATE INDEX idx_feedback_project_unhandled ON feedback (project_id, created_at) WHERE issue_url IS NULL;

UPDATE meta SET value = '3' WHERE key = 'schema_version';
