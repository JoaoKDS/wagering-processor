import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { OutboxPublisher, type EventBus, type OutboxEvent } from "../../src/outbox/outbox-publisher";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";

let sql: SQL;
let orm: MikroORM;

beforeAll(async () => {
  sql = new SQL(url);
  await runMigrations(sql, "reset");
  orm = await createOrm(url);
});

afterAll(async () => {
  await orm.close();
  await sql.close();
});

/** Barramento em memória que registra cada evento publicado. */
class RecordingBus implements EventBus {
  readonly published: string[] = [];
  async publish(event: OutboxEvent): Promise<void> {
    this.published.push(event.id);
  }
}

describe("worker do outbox", () => {
  test("dois publishers concorrentes não publicam o mesmo evento (SKIP LOCKED)", async () => {
    // gera eventos reais via use case
    const submit = new SubmitWagerTransaction(orm);
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const now = new Date();
    await sql`INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
              VALUES (${walletId}, ${playerId}, 'BRL', 1000000, 1, ${now}, ${now})`;
    for (let i = 0; i < 30; i++) {
      const ext = `outbox-${i}-${crypto.randomUUID()}`;
      await submit.execute({
        idempotencyKey: `provider-a:${ext}`,
        providerId: "provider-a",
        externalTransactionId: ext,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      });
    }

    const [pending] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    expect(pending.n).toBeGreaterThanOrEqual(60); // 30 transações + 30 saldos

    const busA = new RecordingBus();
    const busB = new RecordingBus();
    const publisherA = new OutboxPublisher(orm, busA, 5);
    const publisherB = new OutboxPublisher(orm, busB, 5);

    // rodam em paralelo até esvaziar a fila
    await Promise.all([
      (async () => { while ((await publisherA.publishBatch()) > 0); })(),
      (async () => { while ((await publisherB.publishBatch()) > 0); })(),
    ]);

    const all = [...busA.published, ...busB.published];
    expect(new Set(all).size).toBe(all.length); // nenhum evento publicado duas vezes
    expect(all.length).toBeGreaterThanOrEqual(60);

    const [left] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    expect(left.n).toBe(0);
  });
});
