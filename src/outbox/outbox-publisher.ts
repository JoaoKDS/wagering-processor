import type { MikroORM } from "@mikro-orm/postgresql";
import { query, run, transactionConn } from "../wagering/infrastructure/ledger-store";

export interface OutboxEvent {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
}

/** Porta de publicação. Na entrega final será o SQS; nos testes, uma lista em memória. */
export interface EventBus {
  publish(event: OutboxEvent): Promise<void>;
}

/**
 * Worker do outbox. Vários publishers podem rodar ao mesmo tempo:
 * FOR UPDATE SKIP LOCKED faz cada um pegar lotes diferentes, sem bloquear os outros.
 *
 * Semântica at-least-once: se o processo morrer depois de publicar e antes do commit,
 * o evento volta a ser publicado. O consumidor deduplica pela inbox (consumerName, messageId).
 */
export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly bus: EventBus,
    private readonly batchSize = 50,
  ) {}

  /** Publica um lote. Devolve quantos eventos foram publicados com sucesso. */
  async publishBatch(): Promise<number> {
    return this.orm.em.fork().transactional(async (tx) => {
      // conexão DA transação: sem isso o FOR UPDATE SKIP LOCKED não segura nada
      const conn = transactionConn(tx);
      const events = await query<OutboxEvent>(
        conn,
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts
           FROM outbox_messages
          WHERE published_at IS NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );

      let published = 0;
      for (const event of events) {
        try {
          await this.bus.publish(event);
          await run(conn, "UPDATE outbox_messages SET published_at = now(), attempts = attempts + 1 WHERE id = ?", [event.id]);
          published += 1;
        } catch {
          // backoff exponencial limitado a 5 minutos
          await run(
            conn,
            `UPDATE outbox_messages
                SET attempts = attempts + 1,
                    next_attempt_at = now() + make_interval(secs => LEAST(power(2, attempts + 1), 300))
              WHERE id = ?`,
            [event.id],
          );
        }
      }
      return published;
    });
  }
}
