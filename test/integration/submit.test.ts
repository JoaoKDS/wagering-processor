import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import {
  IdempotencyConflictError,
  SubmitWagerTransaction,
  WalletNotFoundError,
  type SubmitInput,
} from "../../src/wagering/application/submit-wager-transaction";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";

let sql: SQL;
let orm: MikroORM;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  sql = new SQL(url);
  await runMigrations(sql, "reset");
  orm = await createOrm(url);
  submit = new SubmitWagerTransaction(orm);
});

afterAll(async () => {
  await orm.close();
  await sql.close();
});

async function newWallet(balanceMinor: number, playerId = crypto.randomUUID()): Promise<{ walletId: string; playerId: string }> {
  const walletId = crypto.randomUUID();
  const now = new Date();
  await sql`INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
            VALUES (${walletId}, ${playerId}, 'BRL', ${balanceMinor}, 1, ${now}, ${now})`;
  return { walletId, playerId };
}

function bet(walletId: string, playerId: string, amount: string, extra: Partial<SubmitInput> = {}): SubmitInput {
  const external = crypto.randomUUID();
  return {
    idempotencyKey: `provider-a:${external}`,
    providerId: "provider-a",
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
    ...extra,
  };
}

async function balanceOf(walletId: string): Promise<bigint> {
  const [row] = await sql`SELECT balance_minor FROM wallets WHERE id = ${walletId}`;
  return BigInt(row.balance_minor);
}

async function countLedger(walletId: string, direction?: string): Promise<number> {
  const [row] = direction
    ? await sql`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = ${direction}`
    : await sql`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
  return row.n;
}

describe("cenário obrigatório (seção 8)", () => {
  test("duas apostas de 80 com saldo 100 em paralelo: exatamente uma PROCESSED, uma REJECTED", async () => {
    const w = await newWallet(10000);
    const [a, b] = await Promise.all([
      submit.execute(bet(w.walletId, w.playerId, "80.00")),
      submit.execute(bet(w.walletId, w.playerId, "80.00")),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = [a, b].find((r) => r.status === "REJECTED")!;
    expect(rejected.failureCode).toBe("INSUFFICIENT_BALANCE");

    expect(await balanceOf(w.walletId)).toBe(2000n); // 20.00
    expect(await countLedger(w.walletId, "DEBIT")).toBe(1);
  });
});

describe("idempotência", () => {
  test("mesma key 50 vezes em paralelo: um único débito, 49 replays", async () => {
    const w = await newWallet(10000);
    const payload = bet(w.walletId, w.playerId, "25.00", { idempotencyKey: "fixed-key-50" });
    const results = await Promise.all(Array.from({ length: 50 }, () => submit.execute(payload)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await balanceOf(w.walletId)).toBe(7500n);
    expect(await countLedger(w.walletId)).toBe(1);
  });

  test("replay devolve o saldo observado no momento original, mesmo que a carteira tenha mudado", async () => {
    const w = await newWallet(10000);
    const payload = bet(w.walletId, w.playerId, "25.00", { idempotencyKey: "replay-balance" });
    const first = await submit.execute(payload);
    await submit.execute(bet(w.walletId, w.playerId, "10.00")); // muda o saldo depois
    const replay = await submit.execute(payload);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe(first.balance.amount); // 75.00, não o saldo atual
  });

  test("mesma key com payload diferente é conflito, não replay", async () => {
    const w = await newWallet(10000);
    await submit.execute(bet(w.walletId, w.playerId, "25.00", { idempotencyKey: "conflict-key" }));
    await expect(
      submit.execute(bet(w.walletId, w.playerId, "30.00", { idempotencyKey: "conflict-key" })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe("regras de negócio", () => {
  test("carteira inexistente: WalletNotFoundError e nada persistido", async () => {
    await expect(
      submit.execute(bet(crypto.randomUUID(), crypto.randomUUID(), "1.00")),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test("LOSS registra o resultado sem mover saldo e sem lançamento", async () => {
    const w = await newWallet(10000);
    const result = await submit.execute(bet(w.walletId, w.playerId, "0.00", { kind: "LOSS" }));
    expect(result.status).toBe("PROCESSED");
    expect(await balanceOf(w.walletId)).toBe(10000n);
    expect(await countLedger(w.walletId)).toBe(0);
  });

  test("WIN credita e gera lançamento CREDIT", async () => {
    const w = await newWallet(10000);
    await submit.execute(bet(w.walletId, w.playerId, "50.00", { kind: "WIN" }));
    expect(await balanceOf(w.walletId)).toBe(15000n);
    expect(await countLedger(w.walletId, "CREDIT")).toBe(1);
  });

  test("ROLLBACK de uma BET processada devolve o valor; segundo ROLLBACK é rejeitado", async () => {
    const w = await newWallet(10000);
    const betInput = bet(w.walletId, w.playerId, "25.00");
    await submit.execute(betInput);

    const rollback = (key: string): SubmitInput => ({
      ...betInput,
      idempotencyKey: key,
      externalTransactionId: `rb-${key}`,
      kind: "ROLLBACK",
      referenceExternalTransactionId: betInput.externalTransactionId,
    });

    const first = await submit.execute(rollback("rb-1"));
    expect(first.status).toBe("PROCESSED");
    expect(await balanceOf(w.walletId)).toBe(10000n);

    const second = await submit.execute(rollback("rb-2"));
    expect(second.status).toBe("REJECTED");
    expect(second.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await balanceOf(w.walletId)).toBe(10000n);
  });

  test("REFUND antes da BET fica PENDING_REFERENCE e não move saldo", async () => {
    const w = await newWallet(10000);
    const betInput = bet(w.walletId, w.playerId, "25.00");
    const refund = await submit.execute({
      ...betInput,
      idempotencyKey: "refund-early",
      externalTransactionId: "refund-early-ext",
      kind: "REFUND",
      referenceExternalTransactionId: betInput.externalTransactionId,
    });
    expect(refund.status).toBe("PENDING_REFERENCE");
    expect(await balanceOf(w.walletId)).toBe(10000n);
  });

  test("REFUND com valor diferente da BET é rejeitado (reversão parcial fora de escopo)", async () => {
    const w = await newWallet(10000);
    const betInput = bet(w.walletId, w.playerId, "25.00");
    await submit.execute(betInput);
    const refund = await submit.execute({
      ...betInput,
      idempotencyKey: "refund-partial",
      externalTransactionId: "refund-partial-ext",
      kind: "REFUND",
      money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: betInput.externalTransactionId,
    });
    expect(refund.status).toBe("REJECTED");
    expect(refund.failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");
  });
});

describe("outbox gravado na mesma transação", () => {
  test("cada submissão aplicada gera evento de transação e de saldo, no mesmo commit", async () => {
    const w = await newWallet(10000);
    const result = await submit.execute(bet(w.walletId, w.playerId, "25.00"));

    const events = await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${result.transactionId}
                              UNION ALL
                              SELECT event_type FROM outbox_messages WHERE aggregate_id = ${w.walletId}`;
    const types = events.map((e: { event_type: string }) => e.event_type).sort();
    expect(types).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });
});
