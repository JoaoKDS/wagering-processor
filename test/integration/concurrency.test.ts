import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
const NOW = new Date("2026-07-29T15:00:00.000Z");

let sql: SQL;

beforeAll(async () => {
  sql = new SQL({ url, max: 20 });
  await runMigrations(sql, "reset");
});

afterAll(async () => {
  await sql.close();
});

/**
 * Débito atômico e condicional: a checagem de saldo e a atualização acontecem no mesmo
 * UPDATE, então não existe janela entre "ler" e "gravar". Devolve a linha se debitou, ou
 * nenhuma linha se o saldo era insuficiente.
 */
async function conditionalDebit(walletId: string, amount: bigint) {
  const rows = await sql`
    UPDATE wallets
       SET balance_minor = balance_minor - ${amount},
           version = version + 1,
           updated_at = ${NOW}
     WHERE id = ${walletId}
       AND balance_minor >= ${amount}
    RETURNING balance_minor, version`;
  return rows.length === 1 ? rows[0] : null;
}

async function newWallet(balance: bigint): Promise<string> {
  const id = crypto.randomUUID();
  await sql`INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
            VALUES (${id}, ${crypto.randomUUID()}, 'BRL', ${balance}, 1, ${NOW}, ${NOW})`;
  return id;
}

describe("concorrência no saldo", () => {
  test("cenário obrigatório: duas apostas de 80 com saldo de 100 em paralelo → exatamente uma passa", async () => {
    const walletId = await newWallet(10000n); // 100.00
    const results = await Promise.all([conditionalDebit(walletId, 8000n), conditionalDebit(walletId, 8000n)]);

    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);

    const [wallet] = await sql`SELECT balance_minor, version FROM wallets WHERE id = ${walletId}`;
    expect(BigInt(wallet.balance_minor)).toBe(2000n); // 20.00
    expect(wallet.version).toBe(2);
  });

  test("50 apostas idênticas em paralelo sobre saldo para 3: nunca passa do saldo", async () => {
    const walletId = await newWallet(30000n); // 300.00
    // 50 tentativas de 100.00 sobre 300.00: exatamente 3 podem passar
    const attempts = Array.from({ length: 50 }, () => conditionalDebit(walletId, 10000n));
    const results = await Promise.all(attempts);

    const successes = results.filter((r) => r !== null).length;
    expect(successes).toBe(3);

    const [wallet] = await sql`SELECT balance_minor FROM wallets WHERE id = ${walletId}`;
    expect(BigInt(wallet.balance_minor)).toBe(0n);
  });

  test("carteiras diferentes são independentes: processadas em paralelo sem interferência", async () => {
    const walletA = await newWallet(5000n);
    const walletB = await newWallet(5000n);
    const results = await Promise.all([
      conditionalDebit(walletA, 5000n),
      conditionalDebit(walletB, 5000n),
    ]);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  test("saldo nunca fica negativo, mesmo sob muitas tentativas concorrentes", async () => {
    const walletId = await newWallet(1000n);
    await Promise.all(Array.from({ length: 30 }, () => conditionalDebit(walletId, 333n)));
    const [wallet] = await sql`SELECT balance_minor FROM wallets WHERE id = ${walletId}`;
    expect(BigInt(wallet.balance_minor)).toBeGreaterThanOrEqual(0n);
  });

  test("lock por linha (FOR UPDATE) bloqueia a segunda sessão até o commit da primeira", async () => {
    const walletId = await newWallet(10000n);
    const first = await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
      // enquanto esta transação segura o lock, outra sessão tentando NOWAIT deve falhar
      const probe = await sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE NOWAIT`.then(
        () => "acquired",
        (err: Error) => err.message,
      );
      return probe;
    });
    expect(first).toContain("could not obtain lock");
  });
});
