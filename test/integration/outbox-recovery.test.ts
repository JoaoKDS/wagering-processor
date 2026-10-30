import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { CreateWallet } from "../../src/wallet/application/create-wallet";
import { OutboxPublisher, type EventBus, type OutboxEvent } from "../../src/outbox/outbox-publisher";
import { query, transactionConn } from "../../src/wagering/infrastructure/ledger-store";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";

let sql: SQL;
let orm: MikroORM;
let createWallet: CreateWallet;

class RecordingBus implements EventBus {
  readonly events: OutboxEvent[] = [];
  async publish(event: OutboxEvent): Promise<void> {
    this.events.push(event);
  }
}

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

describe("publicador que morre antes de publicar (seção 11, cenário obrigatório)", () => {
  test("commit confirmado; publicador A reivindica o lote e morre; publicador B assume e publica", async () => {
    // Commit confirmado: cria carteira com saldo, o que grava 1 evento na outbox
    await createWallet.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: "10.00", currency: "BRL" } });

    // Publicador A: pega o lote com FOR UPDATE SKIP LOCKED e morre antes de publicar (rollback)
    await orm.em
      .fork()
      .transactional(async (tx) => {
        const conn = transactionConn(tx);
        const claimed = await query<{ id: string }>(
          conn,
          `SELECT id FROM outbox_messages WHERE published_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 50`,
        );
        expect(claimed.length).toBe(1);
        throw new Error("simulated publisher crash");
      })
      .catch(() => {});

    // Nada foi publicado e o evento continua pendente
    const [pendingAfterCrash] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    expect(pendingAfterCrash.n).toBe(1);

    // Publicador B assume e publica o evento
    const bus = new RecordingBus();
    const published = await new OutboxPublisher(orm, bus, 50).publishBatch();
    expect(published).toBe(1);
    expect(bus.events[0]!.event_type).toBe("WalletBalanceChanged");
    expect(bus.events[0]!.payload.eventType).toBe("WalletBalanceChanged");
    expect(bus.events[0]!.payload.version).toBe(1);

    const [pendingAfterRecovery] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    expect(pendingAfterRecovery.n).toBe(0);
  });
});
