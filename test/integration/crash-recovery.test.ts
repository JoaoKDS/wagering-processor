import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DeleteMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { createSqs, ensureQueues, type QueueUrls } from "../../src/messaging/sqs-client";
import { pollOnce, type ConsumerDeps } from "../../src/messaging/consumer";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { runMigrations } from "../../scripts/migrate";

const dbUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
if (!process.env.SQS_ENDPOINT) throw new Error("defina SQS_ENDPOINT, ex.: http://localhost:4566");

let sql: SQL;
let orm: MikroORM;
let sqs: SQSClient;
let queues: QueueUrls;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  sql = new SQL(dbUrl);
  await runMigrations(sql, "reset");
  orm = await createOrm(dbUrl);
  sqs = createSqs();
  submit = new SubmitWagerTransaction(orm);
  queues = await ensureQueues(sqs, `wager-crash-${Date.now()}.fifo`);
});

afterAll(async () => {
  sqs.destroy();
  await orm.close();
  await sql.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("recuperação após queda do worker", () => {
  test("worker morre depois do commit e antes do ack: a mensagem volta e não debita duas vezes", async () => {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const now = new Date();
    await sql`INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
              VALUES (${walletId}, ${playerId}, 'BRL', 10000, 1, ${now}, ${now})`;

    const external = `crash-${crypto.randomUUID()}`;
    const envelope = {
      messageId: `msg-${external}`,
      type: "WagerTransactionRequested",
      occurredAt: now.toISOString(),
      data: {
        providerId: "provider-a",
        externalTransactionId: external,
        idempotencyKey: `provider-a:${external}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      },
    };
    const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: `dedup-${external}`,
      }),
    );

    // Simula a queda: o commit acontece, mas o DeleteMessage falha uma vez.
    let crashOnce = true;
    const crashingSqs = {
      send: (command: unknown) => {
        if (command instanceof DeleteMessageCommand && crashOnce) {
          crashOnce = false;
          return Promise.reject(new Error("simulated crash before ack"));
        }
        return sqs.send(command as never);
      },
      destroy: () => {},
    } as unknown as SQSClient;

    const deps = (client: SQSClient): ConsumerDeps => ({
      sqs: client,
      queueUrl: queues.queueUrl,
      dlqUrl: queues.dlqUrl,
      submit,
      visibilityTimeout: 1,
    });

    const first = await pollOnce(deps(crashingSqs), 1);
    expect(first.deferred).toBe(1);

    // O débito já foi commitado antes da queda
    const [afterCrash] = await sql`SELECT balance_minor FROM wallets WHERE id = ${walletId}`;
    expect(BigInt(afterCrash.balance_minor)).toBe(7500n);

    // A mensagem volta depois da visibilidade; a inbox reconhece e não debita de novo
    await sleep(1500);
    const second = await pollOnce(deps(sqs), 1);
    expect(second.duplicates).toBe(1);

    const [afterRedelivery] = await sql`SELECT balance_minor FROM wallets WHERE id = ${walletId}`;
    expect(BigInt(afterRedelivery.balance_minor)).toBe(7500n);
    const [ledger] = await sql`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
    expect(ledger.n).toBe(1);
  });
});
