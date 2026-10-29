-- 0002: saldo observado no momento do processamento.
-- Necessário para que uma repetição idempotente devolva "o resultado original, incluindo o saldo
-- observado naquele momento" (spec, seção 7), mesmo que a carteira já tenha mudado depois.
ALTER TABLE wager_transactions
  ADD COLUMN balance_observed_minor bigint CHECK (balance_observed_minor >= 0);
