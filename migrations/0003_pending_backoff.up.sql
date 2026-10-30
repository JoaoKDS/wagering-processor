-- 0003: backoff exponencial para PENDING_REFERENCE (spec, seção 7.1).
-- reference_attempts conta as reavaliações; next_attempt_at é quando a transação volta a ser tentada.
-- next_attempt_at NULL significa "tentar já" (primeira avaliação).
ALTER TABLE wager_transactions
  ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz;

CREATE INDEX wt_pending_due_idx ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';
