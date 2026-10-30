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

function input(walletId: string, playerId: string, kind: string, amount: string, ref?: string): SubmitInput {
  const external = `de-${kind}-${crypto.randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${external}`,
    providerId: "provider-a",
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: "round-de",
    gameId: "game-de",
    kind,
    money: { amount, currency: "BRL" },
    referenceExternalTransactionId: ref,
  };
}

describe("partidas dobradas (diferencial, seção 6.4)", () => {
  test("cada transação soma zero entre as pernas da carteira e da casa; a casa espelha o saldo", async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } });

    const betInput = input(wallet.id, playerId, "BET", "30.00");
    const bet = await submit.execute(betInput);
    expect(bet.status).toBe("PROCESSED");
    await submit.execute(input(wallet.id, playerId, "BET", "5.00"));
    // ROLLBACK da BET de 30 (referenciada pelo external id): crédito na carteira, débito na casa
    const rollback = await submit.execute(
      input(wallet.id, playerId, "ROLLBACK", "30.00", betInput.externalTransactionId),
    );
    expect(rollback.status).toBe("PROCESSED");

    // 1) Toda transação soma zero: pernas da carteira + pernas da casa
    const [unbalanced] = await sql`
      SELECT count(*)::int AS n FROM (
        SELECT transaction_id, SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END) AS net
          FROM (
            SELECT transaction_id, direction, amount_minor FROM wallet_ledger_entries
            UNION ALL
            SELECT transaction_id, direction, amount_minor FROM house_ledger_entries
          ) legs
         GROUP BY transaction_id
        HAVING SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END) <> 0
      ) bad`;
    expect(unbalanced.n).toBe(0);

    // 2) Uma perna da casa para cada perna da carteira
    const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM wallet_ledger_entries) AS wallet_legs,
             (SELECT count(*)::int FROM house_ledger_entries) AS house_legs`;
    expect(counts.house_legs).toBe(counts.wallet_legs);

    // 3) Saldo da casa == -(soma das pernas da carteira), em BRL
    const [house] = await sql`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::text AS net
                                FROM house_ledger_entries WHERE currency = 'BRL'`;
    const [walletNet] = await sql`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::text AS net
                                    FROM wallet_ledger_entries WHERE currency = 'BRL'`;
    expect(BigInt(house.net)).toBe(-BigInt(walletNet.net));
  });

  test("a perna da casa é append-only, como o ledger da carteira", async () => {
    await expect(sql`UPDATE house_ledger_entries SET amount_minor = 1`).rejects.toThrow();
    await expect(sql`DELETE FROM house_ledger_entries`).rejects.toThrow();
  });
});
