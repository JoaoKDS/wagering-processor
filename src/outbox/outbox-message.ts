import type { IntegrationEvent } from "../shared/integration-event";

/**
 * Mensagem da outbox (spec, seção 6.5). Imutável: cada transição devolve uma nova instância.
 * O publicador SQL em outbox-publisher.ts aplica a mesma regra de backoff de `scheduleRetry`;
 * o teste unitário trava essa fórmula para que as duas não divirjam.
 */
export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

/** Teto do backoff entre tentativas de publicação, em segundos (5 minutos). */
export const OUTBOX_MAX_BACKOFF_SECONDS = 300;

export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {}

  /** Cria a mensagem a partir do evento, na mesma transação que grava o evento. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON() as unknown as Record<string, unknown>,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: null,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get eventType(): string { return this.state.eventType; }
  get payload(): Record<string, unknown> { return this.state.payload; }
  get occurredAt(): Date { return this.state.occurredAt; }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date { return this.state.nextAttemptAt; }
  get publishedAt(): Date | null { return this.state.publishedAt; }

  isPending(): boolean {
    return this.state.publishedAt === null;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): OutboxMessage {
    return new OutboxMessage({ ...this.state, attempts: this.state.attempts + 1, publishedAt: at });
  }

  /** Backoff exponencial: 2^(tentativas+1) segundos, limitado a 5 minutos. */
  scheduleRetry(now: Date): OutboxMessage {
    const seconds = Math.min(2 ** (this.state.attempts + 1), OUTBOX_MAX_BACKOFF_SECONDS);
    return new OutboxMessage({
      ...this.state,
      attempts: this.state.attempts + 1,
      nextAttemptAt: new Date(now.getTime() + seconds * 1000),
    });
  }
}
