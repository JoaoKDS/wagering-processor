import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

/**
 * Cliente SQS. Com SQS_ENDPOINT definido (LocalStack), usa credenciais de teste.
 * Sem ele (produção), usa a cadeia padrão de credenciais da AWS.
 */
export function createSqs(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint,
    ...(endpoint ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}),
  });
}

/** Fila padrão de eventos de integração (publicada pelo outbox). */
export async function ensureEventsQueue(sqs: SQSClient, name = "wager-events"): Promise<string> {
  const res = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  return res.QueueUrl!;
}

export interface QueueUrls {
  queueUrl: string;
  dlqUrl: string;
}

/**
 * Cria a fila principal e a DLQ (ambas FIFO). A principal redireciona para a DLQ
 * depois de maxReceiveCount recebimentos sem ack. Idempotente: criar de novo com os mesmos atributos é seguro.
 */
export async function ensureQueues(sqs: SQSClient, name: string, maxReceiveCount = 5): Promise<QueueUrls> {
  const dlqName = name.replace(/\.fifo$/, "-dlq.fifo");

  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }),
  );
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl!, AttributeNames: ["QueueArn"] }),
  );
  const dlqArn = attrs.Attributes!.QueueArn!;

  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
      },
    }),
  );

  return { queueUrl: main.QueueUrl!, dlqUrl: dlq.QueueUrl! };
}
