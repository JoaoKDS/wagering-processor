-- 0001_init: schema do processador de apostas.
-- As garantias de unicidade, imutabilidade e não-negatividade vivem AQUI (CHECK, UNIQUE, trigger),
-- não só no código de aplicação. Valores monetários em bigint (centavos), nunca float.

CREATE TABLE wallets (
  id            uuid PRIMARY KEY,
  player_id     text        NOT NULL,
  currency      char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_minor bigint      NOT NULL CHECK (balance_minor >= 0),
  version       integer     NOT NULL CHECK (version >= 1),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  -- no máximo uma wallet por jogador + moeda
  CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id                              uuid PRIMARY KEY,
  provider_id                     text        NOT NULL,
  external_transaction_id         text        NOT NULL,
  idempotency_key                 text        NOT NULL,
  payload_hash                    char(64)    NOT NULL,
  wallet_id                       uuid        NOT NULL REFERENCES wallets(id),
  player_id                       text        NOT NULL,
  round_id                        text        NOT NULL,
  game_id                         text        NOT NULL,
  kind                            text        NOT NULL
                                  CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount_minor                    bigint      NOT NULL CHECK (amount_minor >= 0),
  currency                        char(3)     NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id        uuid        REFERENCES wager_transactions(id),
  status                          text        NOT NULL
                                  CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                    text,
  created_at                      timestamptz NOT NULL,
  processed_at                    timestamptz,

  -- identidade externa e chave de idempotência são únicas globalmente
  CONSTRAINT wt_external_uq     UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wt_idempotency_uq  UNIQUE (idempotency_key),

  -- só LOSS pode ter valor zero
  CONSTRAINT wt_amount_rule CHECK (amount_minor > 0 OR kind = 'LOSS'),

  -- REFUND e ROLLBACK exigem referência; BET, LOSS e OPENING não aceitam; WIN é opcional
  CONSTRAINT wt_reference_rule CHECK (
       (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
    OR (kind = 'WIN')
    OR (kind IN ('BET','LOSS','OPENING') AND reference_external_transaction_id IS NULL)
  ),

  -- failureCode existe se e somente se a transação foi rejeitada ou falhou
  CONSTRAINT wt_failure_code_rule CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),

  -- processed_at existe se e somente se a transação foi processada
  CONSTRAINT wt_processed_rule CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL))
);

-- Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
-- Ex.: uma BET aceita um único REFUND e uma única ROLLBACK processados.
CREATE UNIQUE INDEX wt_single_reversal_uq
  ON wager_transactions (reference_transaction_id, kind)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

-- Worker de referências fora de ordem varre só as pendentes.
CREATE INDEX wt_pending_reference_idx
  ON wager_transactions (created_at)
  WHERE status = 'PENDING_REFERENCE';

CREATE TABLE wallet_ledger_entries (
  id                   uuid PRIMARY KEY,
  wallet_id            uuid        NOT NULL REFERENCES wallets(id),
  transaction_id       uuid        NOT NULL REFERENCES wager_transactions(id),
  -- versão da wallet APÓS este lançamento; única por wallet, o que impede dois lançamentos
  -- concorrentes com a mesma base (lost update) mesmo se a aplicação falhar em checar
  wallet_version       integer     NOT NULL CHECK (wallet_version >= 1),
  direction            text        NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor         bigint      NOT NULL CHECK (amount_minor > 0),
  currency             char(3)     NOT NULL,
  balance_before_minor bigint      NOT NULL CHECK (balance_before_minor >= 0),
  balance_after_minor  bigint      NOT NULL CHECK (balance_after_minor >= 0),
  created_at           timestamptz NOT NULL,

  -- aritmética do lançamento verificada pelo banco
  CONSTRAINT wle_arithmetic CHECK (
       (direction = 'CREDIT' AND balance_after_minor = balance_before_minor + amount_minor)
    OR (direction = 'DEBIT'  AND balance_after_minor = balance_before_minor - amount_minor)
  ),

  -- no máximo um lançamento por wallet por transação
  CONSTRAINT wle_one_per_wallet_tx_uq UNIQUE (transaction_id, wallet_id),
  -- sequência de versões por wallet sem buracos nem duplicatas
  CONSTRAINT wle_wallet_version_uq UNIQUE (wallet_id, wallet_version)
);

-- Ledger é append-only: UPDATE e DELETE são bloqueados no banco.
CREATE FUNCTION wallet_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries é append-only (% bloqueado)', TG_OP;
END;
$$;

CREATE TRIGGER wallet_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_append_only();

-- Inbox: deduplicação persistente de mensagens recebidas da fila.
CREATE TABLE inbox_messages (
  consumer_name text        NOT NULL,
  message_id    text        NOT NULL,
  payload_hash  char(64)    NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

-- Outbox: eventos gravados na mesma transação SQL da alteração financeira.
CREATE TABLE outbox_messages (
  id              uuid PRIMARY KEY,
  aggregate_id    text        NOT NULL,
  event_type      text        NOT NULL,
  payload         jsonb       NOT NULL,
  occurred_at     timestamptz NOT NULL,
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  published_at    timestamptz
);

-- Publishers varrem só o que ainda não foi publicado.
CREATE INDEX outbox_pending_idx
  ON outbox_messages (next_attempt_at)
  WHERE published_at IS NULL;
