import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";

/** Retorna true se a fila principal responde. Sem URL configurada, a readiness falha. */
export function makeSqsProbe(sqs: SQSClient, queueUrl: string | undefined): () => Promise<boolean> {
  return async () => {
    if (!queueUrl) return false;
    try {
      await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }));
      return true;
    } catch {
      return false;
    }
  };
}
