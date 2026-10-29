import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
const HASH = "a".repeat(64);
const NOW = new Date("2026-07-29T15:00:00.000Z");

let sql: SQL;

beforeAll(async () => {
  sql = new SQL(url);
  await runMigrations(sql, "reset");
});

afterAll(async () => {
  await sql.close();
});

/** Espera que a operação falhe e devolve a mensagem do erro do Postgres. */
async function expectDbError(op: () => Promise<unknown>): Promise<string> {
  try {
    await op();
  } catch (err) {
    return String((err as Error).message ?? err);
  }
  throw new Error("esperava erro do banco, mas a operação passou");
}

async function insertWallet(playerId = crypto.randomUUID(), currency = "BRL", balance = 0n) {
  const id = crypto.randomUUID();
  await sql`INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
            VALUES (${id}, ${playerId}, ${currency}, ${balance}, 1, ${NOW}, ${NOW})`;
  return { id, playerId };
}

async function insertTx(opts: {
  walletId: string;
  playerId: string;
  externalId?: string;
  provider?: string;
  idempotencyKey?: string;
  kind?: string;
  status?: string;
  amount?: bigint;
  reference?: string | null;
  referenceTxId?: string | null;
  failureCode?: string | null;
  processedAt?: Date | null;
}) {
  const id = crypto.randomUUID();
  const provider = opts.provider ?? "provider-a";
  const external = opts.externalId ?? crypto.randomUUID();
  await sql`INSERT INTO wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
      reference_external_transaction_id, reference_transaction_id,
      status, failure_code, created_at, processed_at
    ) VALUES (
      ${id}, ${provider}, ${external}, ${opts.idempotencyKey ?? `${provider}:${external}`}, ${HASH},
      ${opts.walletId}, ${opts.playerId}, 'round-1', 'game-1', ${opts.kind ?? "BET"},
      ${opts.amount ?? 2500n}, 'BRL',
      ${opts.reference ?? null}, ${opts.referenceTxId ?? null},
      ${opts.status ?? "PENDING"}, ${opts.failureCode ?? null}, ${NOW}, ${opts.processedAt ?? null}
    )`;
  return { id, external };
}

describe("wallets", () => {
  test("bloqueia duas wallets para o mesmo jogador + moeda", async () => {
    const { playerId } = await insertWallet("dup-player", "BRL");
    const msg = await expectDbError(() => insertWallet(playerId, "BRL"));
    expect(msg).toContain("wallets_player_currency_uq");
  });

  test("permite o mesmo jogador com outra moeda", async () => {
    const { playerId } = await insertWallet("multi-currency", "BRL");
    await expect(insertWallet(playerId, "USD")).resolves.toBeDefined();
  });

  test("bloqueia saldo negativo no banco", async () => {
    const msg = await expectDbError(() => insertWallet(undefined, "BRL", -1n));
    expect(msg).toContain("balance_minor");
  });

  test("bloqueia moeda fora do formato ISO", async () => {
    const msg = await expectDbError(() => insertWallet(undefined, "brl"));
    expect(msg).toContain("currency");
  });
});

describe("wager_transactions", () => {
  test("bloqueia a mesma identidade externa do provedor", async () => {
    const w = await insertWallet();
    await insertTx({ walletId: w.id, playerId: w.playerId, externalId: "ext-1" });
    const msg = await expectDbError(() =>
      insertTx({ walletId: w.id, playerId: w.playerId, externalId: "ext-1", idempotencyKey: "outra-key" }),
    );
    expect(msg).toContain("wt_external_uq");
  });

  test("a mesma external id em providers diferentes é permitida", async () => {
    const w = await insertWallet();
    await insertTx({ walletId: w.id, playerId: w.playerId, externalId: "ext-x", provider: "p1" });
    await expect(
      insertTx({ walletId: w.id, playerId: w.playerId, externalId: "ext-x", provider: "p2" }),
    ).resolves.toBeDefined();
  });

  test("bloqueia chave de idempotência duplicada", async () => {
    const w = await insertWallet();
    await insertTx({ walletId: w.id, playerId: w.playerId, idempotencyKey: "fixed-key" });
    const msg = await expectDbError(() =>
      insertTx({ walletId: w.id, playerId: w.playerId, idempotencyKey: "fixed-key" }),
    );
    expect(msg).toContain("wt_idempotency_uq");
  });

  test("REFUND sem referência é bloqueado", async () => {
    const w = await insertWallet();
    const msg = await expectDbError(() =>
      insertTx({ walletId: w.id, playerId: w.playerId, kind: "REFUND", reference: null }),
    );
    expect(msg).toContain("wt_reference_rule");
  });

  test("BET com referência é bloqueada", async () => {
    const w = await insertWallet();
    const msg = await expectDbError(() =>
      insertTx({ walletId: w.id, playerId: w.playerId, kind: "BET", reference: "x" }),
    );
    expect(msg).toContain("wt_reference_rule");
  });

  test("aposta com valor zero é bloqueada; LOSS com zero é aceita", async () => {
    const w = await insertWallet();
    const msg = await expectDbError(() =>
      insertTx({ walletId: w.id, playerId: w.playerId, kind: "BET", amount: 0n }),
    );
    expect(msg).toContain("wt_amount_rule");
    await expect(
      insertTx({ walletId: w.id, playerId: w.playerId, kind: "LOSS", amount: 0n }),
    ).resolves.toBeDefined();
  });

  test("failure_code só existe em REJECTED/FAILED", async () => {
    const w = await insertWallet();
    const msg = await expectDbError(() =>
      insertTx({ walletId: w.id, playerId: w.playerId, status: "PENDING", failureCode: "INSUFFICIENT_BALANCE" }),
    );
    expect(msg).toContain("wt_failure_code_rule");
  });

  test("status PROCESSED exige processed_at", async () => {
    const w = await insertWallet();
    const msg = await expectDbError(() =>
      insertTx({ walletId: w.id, playerId: w.playerId, status: "PROCESSED", processedAt: null }),
    );
    expect(msg).toContain("wt_processed_rule");
  });

  test("uma referência não pode ser revertida duas vezes pelo mesmo tipo", async () => {
    const w = await insertWallet();
    const bet = await insertTx({ walletId: w.id, playerId: w.playerId, status: "PROCESSED", processedAt: NOW });
    await insertTx({
      walletId: w.id,
      playerId: w.playerId,
      kind: "REFUND",
      reference: bet.external,
      referenceTxId: bet.id,
      status: "PROCESSED",
      processedAt: NOW,
    });
    const msg = await expectDbError(() =>
      insertTx({
        walletId: w.id,
        playerId: w.playerId,
        kind: "REFUND",
        reference: bet.external,
        referenceTxId: bet.id,
        status: "PROCESSED",
        processedAt: NOW,
      }),
    );
    expect(msg).toContain("wt_single_reversal_uq");
  });
});

describe("wallet_ledger_entries", () => {
  async function insertLedger(opts: {
    walletId: string;
    txId: string;
    version: number;
    direction?: string;
    amount?: bigint;
    before?: bigint;
    after?: bigint;
  }) {
    await sql`INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, wallet_version, direction, amount_minor, currency,
        balance_before_minor, balance_after_minor, created_at
      ) VALUES (
        ${crypto.randomUUID()}, ${opts.walletId}, ${opts.txId}, ${opts.version},
        ${opts.direction ?? "DEBIT"}, ${opts.amount ?? 2500n}, 'BRL',
        ${opts.before ?? 10000n}, ${opts.after ?? 7500n}, ${NOW}
      )`;
  }

  test("aritmética inconsistente é bloqueada", async () => {
    const w = await insertWallet(undefined, "BRL", 7500n);
    const tx = await insertTx({ walletId: w.id, playerId: w.playerId });
    const msg = await expectDbError(() =>
      insertLedger({ walletId: w.id, txId: tx.id, version: 2, before: 10000n, after: 1n }),
    );
    expect(msg).toContain("wle_arithmetic");
  });

  test("lançamento válido é aceito", async () => {
    const w = await insertWallet(undefined, "BRL", 7500n);
    const tx = await insertTx({ walletId: w.id, playerId: w.playerId });
    await insertLedger({ walletId: w.id, txId: tx.id, version: 2 }); // não lança = aceito
    const [count] = await sql`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${w.id}`;
    expect(count.n).toBe(1);
  });

  test("UPDATE e DELETE são bloqueados pelo trigger (append-only)", async () => {
    const w = await insertWallet(undefined, "BRL", 7500n);
    const tx = await insertTx({ walletId: w.id, playerId: w.playerId });
    await insertLedger({ walletId: w.id, txId: tx.id, version: 2 });

    const upd = await expectDbError(() => sql`UPDATE wallet_ledger_entries SET amount_minor = 1 WHERE wallet_id = ${w.id}`);
    expect(upd).toContain("append-only");
    const del = await expectDbError(() => sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${w.id}`);
    expect(del).toContain("append-only");
  });

  test("duas entradas com a mesma versão da wallet são bloqueadas (lost update)", async () => {
    const w = await insertWallet(undefined, "BRL", 7500n);
    const tx1 = await insertTx({ walletId: w.id, playerId: w.playerId });
    const tx2 = await insertTx({ walletId: w.id, playerId: w.playerId });
    await insertLedger({ walletId: w.id, txId: tx1.id, version: 2 });
    const msg = await expectDbError(() => insertLedger({ walletId: w.id, txId: tx2.id, version: 2 }));
    expect(msg).toContain("wle_wallet_version_uq");
  });

  test("no máximo um lançamento por wallet por transação", async () => {
    const w = await insertWallet(undefined, "BRL", 7500n);
    const tx = await insertTx({ walletId: w.id, playerId: w.playerId });
    await insertLedger({ walletId: w.id, txId: tx.id, version: 2 });
    const msg = await expectDbError(() => insertLedger({ walletId: w.id, txId: tx.id, version: 3 }));
    expect(msg).toContain("wle_one_per_wallet_tx_uq");
  });
});

describe("inbox e outbox", () => {
  test("inbox deduplica por (consumer, messageId)", async () => {
    const insert = () =>
      sql`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
          VALUES ('wager-consumer', 'msg-123', ${HASH}, ${NOW})`;
    await insert();
    const msg = await expectDbError(insert);
    expect(msg).toContain("inbox_messages_pkey");
  });

  test("mesma messageId para consumers diferentes é permitida", async () => {
    await expect(
      sql`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
          VALUES ('outro-consumer', 'msg-123', ${HASH}, ${NOW})`,
    ).resolves.toBeDefined();
  });

  test("outbox aceita evento com payload jsonb", async () => {
    await expect(
      sql`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
          VALUES (${crypto.randomUUID()}, 'wallet-1', 'WalletBalanceChanged', ${JSON.stringify({ a: 1 })}::jsonb, ${NOW}, ${NOW})`,
    ).resolves.toBeDefined();
  });
});
