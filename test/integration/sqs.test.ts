import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { createSqs, ensureQueues, type QueueUrls } from "../../src/messaging/sqs-client";
import { pollOnce, type ConsumerDeps } from "../../src/messaging/consumer";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { runMigrations } from "../../scripts/migrate";

// Exige LocalStack real: não há mock de SQS nestes testes (spec, seção 13).
const dbUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
if (!process.env.SQS_ENDPOINT) {
  throw new Error("defina SQS_ENDPOINT, ex.: http://localhost:4566");
}

let sql: SQL;
let orm: MikroORM;
let sqs: SQSClient;
let queues: QueueUrls;
let deps: ConsumerDeps;

// nome único por execução: não depende de purge
const QUEUE_NAME = `wager-test-${Date.now()}.fifo`;

beforeAll(async () => {
  sql = new SQL(dbUrl);
  await runMigrations(sql, "reset");
  orm = await createOrm(dbUrl);
  sqs = createSqs();
  queues = await ensureQueues(sqs, QUEUE_NAME);
  deps = { sqs, queueUrl: queues.queueUrl, dlqUrl: queues.dlqUrl, submit: new SubmitWagerTransaction(orm) };
});

afterAll(async () => {
  sqs.destroy();
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

function envelope(walletId: string, playerId: string, amount: string, messageId = crypto.randomUUID(), external = crypto.randomUUID()) {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: external,
      idempotencyKey: `provider-a:${external}`,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
  };
}

async function send(body: string, group: string, dedupId = crypto.randomUUID()): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: dedupId,
    }),
  );
}

/** Drena a fila até não sobrar nada visível. */
async function drain(d: ConsumerDeps): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const stats = await pollOnce(d, 0);
    if (stats.processed + stats.duplicates + stats.deadLettered + stats.deferred === 0) return;
  }
}

async function balanceOf(walletId: string): Promise<bigint> {
  const [row] = await sql`SELECT balance_minor FROM wallets WHERE id = ${walletId}`;
  return BigInt(row.balance_minor);
}

describe("consumidor SQS com LocalStack", () => {
  test("mensagem válida é processada e removida da fila", async () => {
    const w = await newWallet(10000);
    const env = envelope(w.walletId, w.playerId, "25.00");
    await send(JSON.stringify(env), w.walletId);

    await drain(deps);
    expect(await balanceOf(w.walletId)).toBe(7500n);
  });

  test("a mesma messageId entregue duas vezes debita uma vez só (inbox)", async () => {
    const w = await newWallet(10000);
    const env = envelope(w.walletId, w.playerId, "10.00", "dup-message-id");
    await send(JSON.stringify(env), w.walletId, "dedup-1");
    await send(JSON.stringify(env), w.walletId, "dedup-2"); // dedupe do SQS não pega: ids diferentes

    const stats = { processed: 0, duplicates: 0 };
    for (let i = 0; i < 5; i++) {
      const s = await pollOnce(deps, 0);
      stats.processed += s.processed;
      stats.duplicates += s.duplicates;
    }
    expect(stats.processed).toBe(1);
    expect(stats.duplicates).toBe(1);
    expect(await balanceOf(w.walletId)).toBe(9000n);
  });

  test("mensagem malformada vai para a DLQ e sai da fila principal", async () => {
    await send("{isso não é json", "bad-group", "bad-1");
    await drain(deps);

    const dlq = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    const bodies = (dlq.Messages ?? []).map((m) => JSON.parse(m.Body!));
    expect(bodies.some((b) => b.body === "{isso não é json" && /JSON inválido/.test(b.reason))).toBe(true);
  });

  test("dois consumidores em paralelo processam 20 apostas da mesma carteira sem perder nem duplicar", async () => {
    const w = await newWallet(1000000);
    for (let i = 0; i < 20; i++) {
      await send(JSON.stringify(envelope(w.walletId, w.playerId, "5.00")), w.walletId);
    }

    const second: ConsumerDeps = { ...deps, submit: new SubmitWagerTransaction(orm) };
    await Promise.all([drain(deps), drain(second)]);

    expect(await balanceOf(w.walletId)).toBe(1000000n - 20n * 500n);
    const [count] = await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${w.walletId} AND kind = 'BET'`;
    expect(count.n).toBe(20);
  });
});
