import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { runMigrations } from "../../scripts/migrate";
import { createSqs, ensureEventsQueue } from "../../src/messaging/sqs-client";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
process.env.DATABASE_URL = url;

let sql: SQL;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  sql = new SQL(url);
  await runMigrations(sql, "reset");
  // /health/ready verifica o SQS: cria uma fila de teste e aponta a variável antes de montar o app
  const setupSqs = createSqs();
  process.env.SQS_QUEUE_URL = await ensureEventsQueue(setupSqs, `wager-http-${Date.now()}`);
  setupSqs.destroy();

  const { AppModule } = await import("../../src/app.module");
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await sql.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function newWallet(balance = "1000.00") {
  const playerId = crypto.randomUUID();
  const res = await call("POST", "/wallets", { playerId, initialBalance: { amount: balance, currency: "BRL" } });
  return { walletId: res.body.id as string, playerId };
}

function betBody(walletId: string, playerId: string, amount: string, external = crypto.randomUUID()) {
  return {
    providerId: "provider-a",
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

describe("wallets", () => {
  test("POST /wallets cria com saldo inicial e version 1", async () => {
    const playerId = crypto.randomUUID();
    const res = await call("POST", "/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(res.body.version).toBe(1);
  });

  test("POST /wallets duplicada para o mesmo jogador e moeda: 409", async () => {
    const { playerId } = await newWallet();
    const res = await call("POST", "/wallets", { playerId, initialBalance: { amount: "1.00", currency: "BRL" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("GET /wallets/:id devolve o saldo; carteira inexistente: 404", async () => {
    const { walletId } = await newWallet("50.00");
    const ok = await call("GET", `/wallets/${walletId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.balance.amount).toBe("50.00");

    const missing = await call("GET", `/wallets/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});

describe("submissão de transação", () => {
  test("BET aprovada: 200 PROCESSED com saldo atualizado", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const body = betBody(walletId, playerId, "25.00");
    const res = await call("POST", "/wagering/transactions", body, { "Idempotency-Key": `provider-a:${body.externalTransactionId}` });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PROCESSED");
    expect(res.body.balance.amount).toBe("75.00");
    expect(res.body.idempotentReplay).toBe(false);
  });

  test("mesma key e mesmo payload: 200 com idempotentReplay true", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const body = betBody(walletId, playerId, "10.00");
    const headers = { "Idempotency-Key": `provider-a:${body.externalTransactionId}` };
    await call("POST", "/wagering/transactions", body, headers);
    const replay = await call("POST", "/wagering/transactions", body, headers);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("mesma key com payload diferente: 409 IDEMPOTENCY_CONFLICT", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const body = betBody(walletId, playerId, "10.00");
    const headers = { "Idempotency-Key": "conflict-http" };
    await call("POST", "/wagering/transactions", body, headers);
    const conflict = await call("POST", "/wagering/transactions", { ...body, money: { amount: "11.00", currency: "BRL" } }, headers);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("aposta sem saldo: 422 com failureCode INSUFFICIENT_BALANCE e ação sugerida", async () => {
    const { walletId, playerId } = await newWallet("10.00");
    const body = betBody(walletId, playerId, "50.00");
    const res = await call("POST", "/wagering/transactions", body, { "Idempotency-Key": `k-${body.externalTransactionId}` });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.failureCode).toBe("INSUFFICIENT_BALANCE");
    expect(res.body.failureAction).toBe("GIVE_UP");
  });

  test("sem header Idempotency-Key: 400", async () => {
    const { walletId, playerId } = await newWallet();
    const res = await call("POST", "/wagering/transactions", betBody(walletId, playerId, "1.00"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });

  test("valor com formato inválido: 400", async () => {
    const { walletId, playerId } = await newWallet();
    const res = await call("POST", "/wagering/transactions", betBody(walletId, playerId, "1e3"), { "Idempotency-Key": "bad-amount" });
    expect(res.status).toBe(400);
  });

  test("carteira inexistente na submissão: 404", async () => {
    const res = await call("POST", "/wagering/transactions", betBody(crypto.randomUUID(), crypto.randomUUID(), "1.00"), {
      "Idempotency-Key": "no-wallet",
    });
    expect(res.status).toBe(404);
  });

  test("consulta por id e por provider + externalId", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const body = betBody(walletId, playerId, "5.00");
    const created = await call("POST", "/wagering/transactions", body, { "Idempotency-Key": `q-${body.externalTransactionId}` });

    const byId = await call("GET", `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.status).toBe("PROCESSED");

    const byExt = await call("GET", `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExt.status).toBe(200);
    expect(byExt.body.id).toBe(created.body.transactionId);
  });
});

describe("ledger e reconciliação", () => {
  test("ledger lista lançamentos em ordem decrescente e reconciliação confirma o saldo", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    await call("POST", "/wagering/transactions", betBody(walletId, playerId, "30.00"), { "Idempotency-Key": `l1-${crypto.randomUUID()}` });
    await call("POST", "/wagering/transactions", betBody(walletId, playerId, "20.00"), { "Idempotency-Key": `l2-${crypto.randomUUID()}` });

    const ledger = await call("GET", `/wallets/${walletId}/ledger?limit=10`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.entries).toHaveLength(3); // abertura + 2 apostas
    expect(ledger.body.entries[0].version).toBeGreaterThan(ledger.body.entries[1].version);

    const rec = await call("POST", `/wallets/${walletId}/reconciliation`);
    expect(rec.status).toBe(201);
    expect(rec.body.consistent).toBe(true);
    expect(rec.body.difference.amount).toBe("0.00");
    expect(rec.body.checkedEntries).toBe(3);
  });

  test("cursor inválido no ledger: 400", async () => {
    const { walletId } = await newWallet();
    const res = await call("GET", `/wallets/${walletId}/ledger?cursor=%%%`);
    expect(res.status).toBe(400);
  });
});

describe("health", () => {
  test("live e ready respondem sem autenticação", async () => {
    const live = await call("GET", "/health/live");
    expect(live.status).toBe(200);
    const ready = await call("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.db).toBe(true);
  });
});
