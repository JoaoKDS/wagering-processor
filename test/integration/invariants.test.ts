import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { SubmitWagerTransaction, type SubmitInput } from "../../src/wagering/application/submit-wager-transaction";
import { CreateWallet } from "../../src/wallet/application/create-wallet";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";

let sql: SQL;
let orm: MikroORM;
let submit: SubmitWagerTransaction;
let createWallet: CreateWallet;

beforeAll(async () => {
  sql = new SQL(url);
  await runMigrations(sql, "reset");
  orm = await createOrm(url);
  submit = new SubmitWagerTransaction(orm);
  createWallet = new CreateWallet(orm);
});

afterAll(async () => {
  await orm.close();
  await sql.close();
});

describe("invariantes globais (seção 13)", () => {
  test("após apostas concorrentes: saldo == soma do ledger, saldo não negativo, version == última versão do ledger", async () => {
    // 8 carteiras com 50.00 cada, criadas pelo caso de uso real (grava abertura + lançamento)
    const wallets: Array<{ walletId: string; playerId: string }> = [];
    for (let w = 0; w < 8; w++) {
      const playerId = crypto.randomUUID();
      const created = await createWallet.execute({
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      });
      wallets.push({ walletId: created.id, playerId });
    }

    // 200 apostas concorrentes distribuídas entre as carteiras (algumas serão REJECTED por saldo)
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 200; i++) {
      const target = wallets[i % wallets.length]!;
      const external = `inv-${i}-${crypto.randomUUID()}`;
      const input: SubmitInput = {
        idempotencyKey: `provider-a:${external}`,
        providerId: "provider-a",
        externalTransactionId: external,
        playerId: target.playerId,
        walletId: target.walletId,
        roundId: "round-inv",
        gameId: "game-inv",
        kind: "BET",
        money: { amount: `${((i * 37) % 30) + 1}.00`, currency: "BRL" },
      };
      ops.push(submit.execute(input));
    }
    const settled = await Promise.allSettled(ops);
    const unexpected = settled.filter((s) => s.status === "rejected");
    expect(unexpected.length).toBe(0);

    for (const w of wallets) {
      const [wallet] = await sql`SELECT balance_minor, version FROM wallets WHERE id = ${w.walletId}`;
      const [sum] = await sql`
        SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::text AS calc,
               max(wallet_version)::int AS last_version
          FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId}`;

      const balance = BigInt(wallet.balance_minor);
      expect(balance).toBeGreaterThanOrEqual(0n);
      expect(balance).toBe(BigInt(sum.calc));
      expect(sum.last_version).toBe(wallet.version);
    }
  });
});
