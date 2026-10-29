import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { MoneyProps } from "../shared/money";
import { toHttpException } from "../http/errors";
import type { SubmitInput, SubmitWagerTransaction } from "../wagering/application/submit-wager-transaction";

export interface ConsumerDeps {
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  submit: SubmitWagerTransaction;
}

export interface PollStats {
  processed: number;
  duplicates: number;
  deadLettered: number;
  deferred: number;
}

/** Erro permanente: a mensagem nunca vai passar. Vai para a DLQ. */
export class PermanentMessageError extends Error {}

interface Envelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * Lê um lote, processa cada mensagem e decide o destino:
 * - sucesso ou duplicata: ack (DeleteMessage) depois do commit;
 * - erro transitório (5xx, banco indisponível): não ack, volta à fila após a visibilidade;
 * - erro permanente (JSON inválido, regra de contrato): envia para a DLQ e só então faz ack.
 *
 * Regra de negócio (REJECTED) NÃO é erro: a transação foi registrada como rejeitada, então é ack.
 */
export async function pollOnce(deps: ConsumerDeps, waitSeconds = 1): Promise<PollStats> {
  const stats: PollStats = { processed: 0, duplicates: 0, deadLettered: 0, deferred: 0 };
  const res = await deps.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: deps.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
      VisibilityTimeout: 30,
    }),
  );

  for (const msg of res.Messages ?? []) {
    const receipt = msg.ReceiptHandle!;
    const body = msg.Body ?? "";
    try {
      const envelope = parseEnvelope(body);
      const outcome = await deps.submit.executeFromQueue(toSubmitInput(envelope), envelope.messageId);
      if (outcome === "DUPLICATE") stats.duplicates++;
      else stats.processed++;
      await ack(deps, receipt);
    } catch (err) {
      if (isTransient(err)) {
        stats.deferred++; // sem ack: a mensagem volta depois da visibilidade
        continue;
      }
      await deps.sqs.send(
        new SendMessageCommand({
          QueueUrl: deps.dlqUrl,
          MessageBody: JSON.stringify({ reason: (err as Error).message, body }),
          MessageGroupId: "dlq",
          MessageDeduplicationId: msg.MessageId ?? crypto.randomUUID(),
        }),
      );
      stats.deadLettered++;
      await ack(deps, receipt);
    }
  }
  return stats;
}

async function ack(deps: ConsumerDeps, receipt: string): Promise<void> {
  await deps.sqs.send(new DeleteMessageCommand({ QueueUrl: deps.queueUrl, ReceiptHandle: receipt }));
}

export function parseEnvelope(body: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PermanentMessageError("JSON inválido");
  }
  const env = parsed as Partial<Envelope> | null;
  if (
    !env ||
    env.type !== "WagerTransactionRequested" ||
    typeof env.messageId !== "string" ||
    typeof env.data !== "object" ||
    env.data === null
  ) {
    throw new PermanentMessageError("envelope inválido");
  }
  return env as Envelope;
}

function toSubmitInput(env: Envelope): SubmitInput {
  const d = env.data;
  return {
    idempotencyKey: String(d.idempotencyKey ?? ""),
    providerId: String(d.providerId ?? ""),
    externalTransactionId: String(d.externalTransactionId ?? ""),
    playerId: String(d.playerId ?? ""),
    walletId: String(d.walletId ?? ""),
    roundId: String(d.roundId ?? ""),
    gameId: String(d.gameId ?? ""),
    kind: String(d.kind ?? ""),
    money: d.money as MoneyProps,
    referenceExternalTransactionId:
      typeof d.referenceExternalTransactionId === "string" ? d.referenceExternalTransactionId : undefined,
  };
}

/** 5xx e falhas de infraestrutura são transitórias. Demais erros são permanentes. */
function isTransient(err: unknown): boolean {
  if (err instanceof PermanentMessageError) return false;
  return toHttpException(err).getStatus() >= 500;
}
