import { createSqs, ensureEventsQueue, ensureQueues } from "../src/messaging/sqs-client";

/** Cria as filas no LocalStack (ou na AWS) e imprime as URLs para o .env. */
const name = process.env.SQS_QUEUE_NAME ?? "wager-transactions.fifo";
const sqs = createSqs();
const { queueUrl, dlqUrl } = await ensureQueues(sqs, name);
console.log(`SQS_QUEUE_URL=${queueUrl}`);
console.log(`SQS_DLQ_URL=${dlqUrl}`);
console.log(`SQS_EVENTS_URL=${await ensureEventsQueue(sqs)}`);
sqs.destroy();
