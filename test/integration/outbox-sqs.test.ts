import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { createSqs, ensureEventsQueue } from "../../src/messaging/sqs-client";
import { SqsEventBus } from "../../src/messaging/sqs-event-bus";
import { OutboxPublisher } from "../../src/outbox/outbox-publisher";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { runMigrations } from "../../scripts/migrate";

const dbUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
if (!process.env.SQS_ENDPOINT) throw new Error("defina SQS_ENDPOINT, ex.: http://localhost:4566");

let sql: SQL;
let orm: MikroORM;
let sqs: SQSClient;
let eventsUrl: string;

beforeAll(async () => {
  sql = new SQL(dbUrl);
  await runMigrations(sql, "reset");
  orm = await createOrm(dbUrl);
  sqs = createSqs();
  eventsUrl = await ensureEventsQueue(sqs, `wager-events-test-${Date.now()}`);
});

afterAll(async () => {
  sqs.destroy();
  await orm.close();
  await sql.close();
});

describe("outbox publicado no SQS", () => {
  test("eventos gravados na transação chegam à fila de eventos e ficam marcados como publicados", async () => {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const now = new Date();
    await sql`INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
              VALUES (${walletId}, ${playerId}, 'BRL', 10000, 1, ${now}, ${now})`;

    const submit = new SubmitWagerTransaction(orm);
    const ext = `evt-${crypto.randomUUID()}`;
    await submit.execute({
      idempotencyKey: `provider-a:${ext}`,
      providerId: "provider-a",
      externalTransactionId: ext,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });

    const publisher = new OutboxPublisher(orm, new SqsEventBus(sqs, eventsUrl), 50);
    let published = 0;
    for (let i = 0; i < 5; i++) {
      const n = await publisher.publishBatch();
      published += n;
      if (n === 0) break;
    }
    expect(published).toBeGreaterThanOrEqual(2);

    const received: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      if (!res.Messages?.length) break;
      for (const m of res.Messages) received.push(JSON.parse(m.Body!).eventType);
    }
    expect(received).toContain("WalletBalanceChanged");
    expect(received).toContain("WagerTransactionProcessed");

    const [pending] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    expect(pending.n).toBe(0);
  });
});
