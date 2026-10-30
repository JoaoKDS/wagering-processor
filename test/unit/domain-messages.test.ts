import { describe, expect, test } from "bun:test";
import { WagerTransactionProcessedEvent, WagerTransactionRejectedEvent } from "../../src/events/integration-events";
import { OutboxMessage, OUTBOX_MAX_BACKOFF_SECONDS } from "../../src/outbox/outbox-message";
import { InboxMessage } from "../../src/messaging/inbox-message";

const snapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  walletId: "22222222-2222-4222-8222-222222222222",
  kind: "BET",
  status: "PROCESSED",
  failureCode: null,
};
const occurredAt = new Date("2026-10-29T12:00:00.000Z");

describe("IntegrationEvent (seção 11)", () => {
  test("envelope tem eventId, eventType, version, correlationId, causationId e occurredAt em ISO-8601", () => {
    const event = WagerTransactionProcessedEvent.from(snapshot, { correlationId: "corr-1", occurredAt });
    const json = event.toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.version).toBe(1);
    expect(json.correlationId).toBe("corr-1");
    expect(json.causationId).toBeNull();
    expect(json.occurredAt).toBe("2026-10-29T12:00:00.000Z");
    expect(json.aggregateId).toBe(snapshot.id);
    expect(json.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("causationId é preservado quando informado", () => {
    const event = WagerTransactionProcessedEvent.from(snapshot, {
      correlationId: "corr-1",
      causationId: "cause-9",
      occurredAt,
    });
    expect(event.toJSON().causationId).toBe("cause-9");
  });

  test("rejeição carrega o failureCode em data", () => {
    const event = WagerTransactionRejectedEvent.from(
      { ...snapshot, status: "REJECTED", failureCode: "INSUFFICIENT_BALANCE" },
      { correlationId: "corr-2", occurredAt },
    );
    expect(event.toJSON().data).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_BALANCE" });
  });
});

describe("OutboxMessage (seção 6.5)", () => {
  const event = WagerTransactionProcessedEvent.from(snapshot, { correlationId: "corr-1", occurredAt });

  test("enqueue cria pendente, com o mesmo id do evento, devida no occurredAt", () => {
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(occurredAt)).toBe(true);
    expect(msg.isDue(new Date(occurredAt.getTime() - 1))).toBe(false);
  });

  test("markPublished tira a mensagem da fila pendente", () => {
    const msg = OutboxMessage.enqueue(event).markPublished(new Date(occurredAt.getTime() + 500));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(new Date(occurredAt.getTime() + 10_000))).toBe(false);
    expect(msg.attempts).toBe(1);
  });

  test("scheduleRetry usa 2^(tentativas+1) segundos, igual à fórmula SQL do publicador", () => {
    const now = new Date("2026-10-29T13:00:00.000Z");
    const first = OutboxMessage.enqueue(event).scheduleRetry(now);
    expect(first.attempts).toBe(1);
    expect(first.nextAttemptAt.getTime() - now.getTime()).toBe(2_000);

    const second = first.scheduleRetry(now);
    expect(second.nextAttemptAt.getTime() - now.getTime()).toBe(4_000);
  });

  test("scheduleRetry respeita o teto de 5 minutos", () => {
    const now = new Date("2026-10-29T13:00:00.000Z");
    let msg = OutboxMessage.enqueue(event);
    for (let i = 0; i < 20; i++) msg = msg.scheduleRetry(now);
    expect(msg.nextAttemptAt.getTime() - now.getTime()).toBe(OUTBOX_MAX_BACKOFF_SECONDS * 1000);
  });

  test("objetos são imutáveis: markPublished não altera a original", () => {
    const original = OutboxMessage.enqueue(event);
    original.markPublished(occurredAt);
    expect(original.isPending()).toBe(true);
  });
});

describe("InboxMessage (seção 6.5)", () => {
  const receivedAt = new Date("2026-10-29T12:00:00.000Z");

  test("receive cria não processada; markProcessed devolve nova instância processada", () => {
    const received = InboxMessage.receive({ consumerName: "wager-consumer", messageId: "m-1", payloadHash: "h", receivedAt });
    expect(received.isProcessed()).toBe(false);

    const processed = received.markProcessed(receivedAt);
    expect(processed.isProcessed()).toBe(true);
    expect(received.isProcessed()).toBe(false);
  });

  test("rehydrate reconstrói o estado persistido", () => {
    const msg = InboxMessage.rehydrate({
      consumerName: "wager-consumer",
      messageId: "m-2",
      payloadHash: "h2",
      receivedAt,
      processedAt: receivedAt,
    });
    expect(msg.messageId).toBe("m-2");
    expect(msg.isProcessed()).toBe(true);
  });
});
