import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { reprocessPendingReferences } from "../../src/wagering/application/pending-reference-worker";
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

async function newWallet(balanceMinor: number) {
  const walletId = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  const now = new Date();
  await sql`INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
            VALUES (${walletId}, ${playerId}, 'BRL', ${balanceMinor}, 1, ${now}, ${now})`;
  return { walletId, playerId };
}

function input(walletId: string, playerId: string, kind: string, amount: string, external: string, reference?: string) {
  return {
    idempotencyKey: `provider-a:${external}`,
    providerId: "provider-a",
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: { amount, currency: "BRL" },
    referenceExternalTransactionId: reference,
  };
}

describe("referência fora de ordem (seção 7.1)", () => {
  test("ROLLBACK chega antes da BET, fica pendente, e é processado quando a BET chega", async () => {
    const w = await newWallet(10000);
    const betExt = `bet-${crypto.randomUUID()}`;
    const rb = await submit.execute(input(w.walletId, w.playerId, "ROLLBACK", "25.00", `rb-${betExt}`, betExt));
    expect(rb.status).toBe("PENDING_REFERENCE");

    await submit.execute(input(w.walletId, w.playerId, "BET", "25.00", betExt));
    const [before] = await sql`SELECT balance_minor FROM wallets WHERE id = ${w.walletId}`;
    expect(BigInt(before.balance_minor)).toBe(7500n);

    const stats = await reprocessPendingReferences(orm, new Date());
    expect(stats.processed).toBe(1);

    const [after] = await sql`SELECT balance_minor FROM wallets WHERE id = ${w.walletId}`;
    expect(BigInt(after.balance_minor)).toBe(10000n);
    const [tx] = await sql`SELECT status FROM wager_transactions WHERE external_transaction_id = ${`rb-${betExt}`}`;
    expect(tx.status).toBe("PROCESSED");
  });

  test("referência que nunca chega é rejeitada com REFERENCE_NOT_FOUND após o TTL", async () => {
    const w = await newWallet(10000);
    const ext = `orphan-${crypto.randomUUID()}`;
    await submit.execute(input(w.walletId, w.playerId, "REFUND", "25.00", `rf-${ext}`, "never-arrives"));

    // "agora" 25h no futuro: ultrapassa o TTL de 24h
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const stats = await reprocessPendingReferences(orm, later);
    expect(stats.rejected).toBe(1);

    const [tx] = await sql`SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ${`rf-${ext}`}`;
    expect(tx.status).toBe("REJECTED");
    expect(tx.failure_code).toBe("REFERENCE_NOT_FOUND");

    const [after] = await sql`SELECT balance_minor FROM wallets WHERE id = ${w.walletId}`;
    expect(BigInt(after.balance_minor)).toBe(10000n);
  });

  test("antes do TTL, referência ausente continua pendente", async () => {
    const w = await newWallet(10000);
    const ext = `young-${crypto.randomUUID()}`;
    await submit.execute(input(w.walletId, w.playerId, "REFUND", "25.00", `ry-${ext}`, "still-missing"));
    const stats = await reprocessPendingReferences(orm, new Date());
    expect(stats.stillPending).toBeGreaterThanOrEqual(1);
    const [tx] = await sql`SELECT status FROM wager_transactions WHERE external_transaction_id = ${`ry-${ext}`}`;
    expect(tx.status).toBe("PENDING_REFERENCE");
  });
});
