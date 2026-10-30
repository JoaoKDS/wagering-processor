DROP INDEX IF EXISTS wt_pending_due_idx;
ALTER TABLE wager_transactions
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS reference_attempts;
