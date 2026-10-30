import { randomUUID } from "node:crypto";

/**
 * Evento de integração (spec, seção 11). Subclasse concreta por evento, com `eventType` e `version`.
 * `data` carrega MoneyProps (string decimal), nunca instâncias de Money.
 */
export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Formato publicado: o mesmo JSON gravado na outbox e enviado ao SQS. */
export interface IntegrationEnvelope<T> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: T;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId ?? null,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }
}
