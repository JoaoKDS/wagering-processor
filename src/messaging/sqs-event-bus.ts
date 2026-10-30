import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventBus, OutboxEvent } from "../outbox/outbox-publisher";

/**
 * Publica eventos de integração numa fila padrão (não FIFO) de eventos.
 * Entrega at-least-once: o consumidor deve deduplicar pelo eventId, como faz a inbox.
 */
export class SqsEventBus implements EventBus {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(event: OutboxEvent): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        // O payload gravado na outbox já é o envelope completo (IntegrationEnvelope).
        MessageBody: JSON.stringify(event.payload),
      }),
    );
  }
}
