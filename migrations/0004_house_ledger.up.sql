-- 0004: partidas dobradas (diferencial, spec seção 6.4).
-- Cada lançamento de carteira ganha uma perna de contrapartida na conta da casa, no mesmo commit.
-- A casa não é uma wallet: ela paga ganhos e pode ficar negativa, então não tem CHECK de saldo.
CREATE TABLE house_ledger_entries (
  id                     uuid PRIMARY KEY,
  wallet_ledger_entry_id uuid        NOT NULL UNIQUE REFERENCES wallet_ledger_entries(id),
  transaction_id         uuid        NOT NULL,
  direction              text        NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor           bigint      NOT NULL CHECK (amount_minor > 0),
  currency               char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at             timestamptz NOT NULL
);

-- Append-only, como o ledger da carteira.
CREATE FUNCTION house_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'house_ledger_entries é append-only (% bloqueado)', TG_OP;
END;
$$;

CREATE TRIGGER house_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON house_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION house_ledger_append_only();
