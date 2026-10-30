import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { fileURLToPath } from "node:url";
import { createOrm } from "../../src/infrastructure/orm";
import { CreateWallet } from "../../src/wallet/application/create-wallet";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
const helper = fileURLToPath(new URL("./helpers/submit-process.ts", import.meta.url));

let sql: SQL;
let orm: MikroORM;
let createWallet: CreateWallet;

beforeAll(async () => {
  sql = new SQL(url);
  await runMigrations(sql, "reset");
  orm = await createOrm(url);
  createWallet = new CreateWallet(orm);
});

afterAll(async () => {
  await orm.close();
  await sql.close();
});

async function newWallet(balance: string) {
  const playerId = crypto.randomUUID();
  const created = await createWallet.execute({ playerId, initialBalance: { amount: balance, currency: "BRL" } });
  return { walletId: created.id, playerId };
}

function spawnSubmitter(walletId: string, playerId: string, prefix: string, count: number, amount: string) {
  return Bun.spawn([process.execPath, helper], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WM_DB_URL: url,
      WM_WALLET_ID: walletId,
      WM_PLAYER_ID: playerId,
      WM_PREFIX: prefix,
      WM_COUNT: String(count),
      WM_AMOUNT: amount,
    },
  });
}

/** Espera o processo filho e devolve código + saída de erro, para o teste mostrar a causa. */
async function finish(p: ReturnType<typeof spawnSubmitter>): Promise<{ code: number; err: string }> {
  const code = await p.exited;
  const err = await new Response(p.stderr).text();
  return { code, err };
}

async function assertConsistent(walletId: string, expectedDebits: number, startMinor: bigint, unitMinor: bigint) {
  const [wallet] = await sql`SELECT balance_minor, version FROM wallets WHERE id = ${walletId}`;
  const [ledger] = await sql`
    SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::text AS calc,
           count(*) FILTER (WHERE direction = 'DEBIT')::int AS debits,
           max(wallet_version)::int AS last_version
      FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;

  // Invariante: saldo == soma do ledger; débitos exatamente iguais às operações únicas
  expect(BigInt(wallet.balance_minor)).toBe(BigInt(ledger.calc));
  expect(BigInt(wallet.balance_minor)).toBe(startMinor - BigInt(expectedDebits) * unitMinor);
  expect(ledger.debits).toBe(expectedDebits);
  expect(ledger.last_version).toBe(wallet.version);
}

describe("três processos reais na mesma carteira (seção 13, item 4)", () => {
  test("3 processos com chaves sobrepostas: cada operação única debita uma vez só", async () => {
    const { walletId, playerId } = await newWallet("1000.00");

    // Os 3 processos enviam as mesmas 10 chaves ("shared-0..9"): só 1 débito por chave, 2 replays cada.
    const results = await Promise.all([
      finish(spawnSubmitter(walletId, playerId, "shared", 10, "1.00")),
      finish(spawnSubmitter(walletId, playerId, "shared", 10, "1.00")),
      finish(spawnSubmitter(walletId, playerId, "shared", 10, "1.00")),
    ]);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(results.map((r) => r.err)).toEqual(["", "", ""]);

    await assertConsistent(walletId, 10, 100000n, 100n);
  });

  test("3 processos com chaves exclusivas: 60 débitos, sem perda", async () => {
    const { walletId, playerId } = await newWallet("1000.00");
    const results = await Promise.all([
      finish(spawnSubmitter(walletId, playerId, "a", 20, "1.00")),
      finish(spawnSubmitter(walletId, playerId, "b", 20, "1.00")),
      finish(spawnSubmitter(walletId, playerId, "c", 20, "1.00")),
    ]);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(results.map((r) => r.err)).toEqual(["", "", ""]);

    await assertConsistent(walletId, 60, 100000n, 100n);
  });
});

describe("reinício com comprovação de consistência (seção 13, item 8)", () => {
  test("processo morto no meio (SIGKILL) e reiniciado com as mesmas chaves: sem débito duplicado", async () => {
    const { walletId, playerId } = await newWallet("1000.00");
    const total = 200;

    const first = spawnSubmitter(walletId, playerId, "restart", total, "1.00");
    // Espera até o processo ter commitado algumas apostas, depois mata sem aviso
    let started = false;
    for (let tries = 0; tries < 200; tries++) {
      const [row] = await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${walletId}`;
      if (row.n >= 20) {
        started = true;
        break;
      }
      await Bun.sleep(25);
    }
    if (!started) {
      const diag = await finish(first);
      throw new Error(`processo não chegou a commitar 20 apostas: code=${diag.code} err=${diag.err}`);
    }
    first.kill("SIGKILL");
    await first.exited;

    // Reinício: reenvia todas as chaves; as já commitadas viram replay, o resto é processado
    const second = await finish(spawnSubmitter(walletId, playerId, "restart", total, "1.00"));
    expect(second.err).toBe("");
    expect(second.code).toBe(0);

    await assertConsistent(walletId, total, 100000n, 100n);
  });
});
