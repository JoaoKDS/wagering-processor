import type { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { DomainError } from "../../shared/domain-error";
import { metrics } from "../../shared/metrics";
import { FailureCode } from "../../shared/failure-code";
import { Money, type MoneyProps } from "../../shared/money";
import { LedgerDirection, WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import type { Wallet } from "../../wallet/domain/wallet";
import {
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
  type TransactionSnapshot,
} from "../../events/integration-events";
import { InboxMessage } from "../../messaging/inbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerPayload,
} from "../domain/wager-transaction";
import {
  type Conn,
  transactionConn,
  query,
  type WagerTxRow,
  findByExternalId,
  findByIdempotencyKey,
  hasProcessedReversal,
  insertLedger,
  insertOutbox,
  insertTransaction,
  lockWallet,
  txFromRow,
  updateWallet,
  walletFromRow,
} from "../infrastructure/ledger-store";

// ---------- erros da aplicação ----------

/** Mesma idempotency key com payload diferente: conflito, nunca replay. Mapeia para HTTP 409. */
export class IdempotencyConflictError extends Error {}

/** Carteira informada não existe. Nada é persistido, porque a transação não tem onde ser ancorada. Mapeia para HTTP 404. */
export class WalletNotFoundError extends Error {}

/** Entrada que não passa nas regras de contrato. Mapeia para HTTP 400. */
export class InvalidSubmissionError extends Error {}

/** Regra de referência violada: vira REJECTED com o failureCode indicado. */
class ReferenceRuleError extends DomainError {
  constructor(readonly failureCode: FailureCode, message: string) {
    super(message);
  }
}

// ---------- contrato de entrada e saída ----------

export interface SubmitInput {
  /** Header Idempotency-Key. É a fonte da verdade para idempotência. */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nome do consumidor na inbox: a chave da deduplicação é (consumerName, messageId). */
export const CONSUMER_NAME = "wager-consumer";

/** Quais tipos de transação podem referenciar cada tipo. Spec, seção 7. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
};

export class SubmitWagerTransaction {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: SubmitInput): Promise<SubmitResult> {
    const outcome = await this.run(input, undefined);
    if (outcome === "DUPLICATE") throw new Error("inbox sem messageId não deveria devolver DUPLICATE");
    return outcome;
  }

  /**
   * Caminho da fila. A inbox (consumerName, messageId) é gravada NA MESMA transação da aplicação:
   * se a mensagem já foi processada, devolve DUPLICATE e nada muda. O ack só acontece após o commit.
   */
  async executeFromQueue(input: SubmitInput, messageId: string): Promise<SubmitResult | "DUPLICATE"> {
    return this.run(input, messageId);
  }

  /** Mede a latência de processamento de ponta a ponta (spec, seção 12). */
  private async run(input: SubmitInput, messageId: string | undefined): Promise<SubmitResult | "DUPLICATE"> {
    const started = performance.now();
    try {
      return await this.runInner(input, messageId);
    } finally {
      metrics.observe("wager_processing_ms", performance.now() - started);
    }
  }

  private async runInner(input: SubmitInput, messageId: string | undefined): Promise<SubmitResult | "DUPLICATE"> {
    const payload = toPayload(input);
    const payloadHash = WagerTransaction.computePayloadHash(payload);
    const now = this.clock();

    return this.orm.em.fork().transactional(async (tx) => {
      const conn = transactionConn(tx);
      if (messageId !== undefined) {
        const inbox = InboxMessage.receive({
          consumerName: CONSUMER_NAME,
          messageId,
          payloadHash,
          receivedAt: now,
        }).markProcessed(now);
        const fresh = await query<{ message_id: string }>(
          conn,
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING
           RETURNING message_id`,
          [inbox.consumerName, inbox.messageId, inbox.payloadHash, inbox.receivedAt, inbox.processedAt],
        );
        if (fresh.length === 0) {
          metrics.inc("inbox_duplicates_total");
          return "DUPLICATE" as const;
        }
      }
      return this.apply(conn, input.idempotencyKey, payload, payloadHash, now);
    });
  }

  private async apply(
    conn: Conn,
    idempotencyKey: string,
    payload: WagerPayload,
    payloadHash: string,
    now: Date,
  ): Promise<SubmitResult> {
    // 1. Trava a carteira. Tudo abaixo acontece com essa linha bloqueada.
    const walletRow = await lockWallet(conn, payload.walletId);
    if (!walletRow) throw new WalletNotFoundError(payload.walletId);

    // 2. Idempotência, já sob o lock: duas requisições idênticas em paralelo são serializadas aqui.
    const sameKey = await findByIdempotencyKey(conn, idempotencyKey);
    if (sameKey) {
      if (sameKey.payload_hash !== payloadHash) throw new IdempotencyConflictError(idempotencyKey);
      return toReplayResult(sameKey);
    }

    // Mesma identidade externa com outra chave: também é conflito.
    const sameExternal = await findByExternalId(conn, payload.providerId, payload.externalTransactionId);
    if (sameExternal) throw new IdempotencyConflictError(idempotencyKey);

    // 3. Decide e aplica.
    const wallet = walletFromRow(walletRow);
    const txn = WagerTransaction.create({ id: randomUUID(), payload, idempotencyKey, now });
    const previousVersion = wallet.version;
    let entry: WalletLedgerEntry | null = null;

    try {
      if (wallet.playerId !== payload.playerId) {
        throw new ReferenceRuleError(FailureCode.INVALID_PAYLOAD, "jogador diferente do dono da wallet");
      }

      if (txn.kind === WagerTransactionKind.Loss) {
        txn.markProcessed(undefined, now); // registra sem mover saldo
      } else if (needsReference(txn)) {
        const ref = await findByExternalId(conn, payload.providerId, payload.referenceExternalTransactionId!);
        if (!ref) {
          txn.markPendingReference(); // reprocessado depois pelo worker de referências
        } else {
          entry = await applyReversal(conn, wallet, txn, txFromRow(ref), now);
          txn.markProcessed(ref.id, now);
        }
      } else {
        const ctx = { entryId: randomUUID(), transactionId: txn.id, now };
        entry = txn.kind === WagerTransactionKind.Bet
          ? wallet.debit(txn.money, ctx, "BET")
          : wallet.credit(txn.money, ctx);
        txn.markProcessed(undefined, now);
      }
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      // Violação de regra de negócio: rejeita, auditável, sem mover saldo nem gerar lançamento.
      entry = null;
      txn.reject(err.failureCode);
    }

    // 4. Persiste tudo no mesmo commit. Ordem importa por causa das foreign keys.
    const balanceObserved = wallet.balance; // pós-operação se aplicou, pré-operação se rejeitou
    await insertTransaction(conn, txn, balanceObserved);

    if (entry) {
      await updateWallet(conn, wallet, previousVersion);
      await insertLedger(conn, entry, wallet.version);
      await insertOutbox(
        conn,
        WalletBalanceChangedEvent.from(entry, wallet.version, { correlationId: txn.id, occurredAt: now }),
      );
    }

    await insertOutbox(conn, transactionEvent(txn, now));

    // Contado antes do commit: aceitável para métrica operacional, e o status é o que foi decidido.
    metrics.inc("wager_transactions_total", { status: txn.status, kind: txn.kind });

    return {
      transactionId: txn.id,
      status: txn.status,
      balance: balanceObserved.toJSON(),
      idempotentReplay: false,
      failureCode: txn.failureCode,
    };
  }
}

// ---------- helpers ----------

function needsReference(txn: WagerTransaction): boolean {
  return txn.requiresReference() || (txn.kind === WagerTransactionKind.Win && txn.referenceExternalTransactionId !== undefined);
}

/**
 * Aplica REFUND ou ROLLBACK (ou WIN com referência). Lança ReferenceRuleError se a regra não passar.
 * Não altera a carteira se lançar, porque as validações rodam antes de qualquer débito ou crédito.
 */
export async function applyReversal(
  conn: Conn,
  wallet: Wallet,
  txn: WagerTransaction,
  ref: WagerTransaction,
  now: Date,
): Promise<WalletLedgerEntry> {
  if (ref.status !== WagerTransactionStatus.Processed) {
    throw new ReferenceRuleError(FailureCode.REFERENCE_NOT_PROCESSED, "referência ainda não processada");
  }
  if (ref.walletId !== txn.walletId || ref.playerId !== txn.playerId
      || ref.roundId !== txn.roundId || ref.providerId !== txn.providerId) {
    throw new ReferenceRuleError(FailureCode.REFERENCE_CONTEXT_MISMATCH, "referência de outro provider, jogador, wallet ou rodada");
  }
  const allowed = ALLOWED_REFERENCE_KINDS[txn.kind] ?? [];
  if (!allowed.includes(ref.kind)) {
    throw new ReferenceRuleError(FailureCode.REFERENCE_KIND_NOT_ALLOWED, `${txn.kind} não pode referenciar ${ref.kind}`);
  }
  if (txn.kind !== WagerTransactionKind.Win && !ref.money.equals(txn.money)) {
    throw new ReferenceRuleError(FailureCode.REFERENCE_AMOUNT_MISMATCH, "reversão parcial está fora de escopo");
  }
  if (txn.requiresReference() && await hasProcessedReversal(conn, ref.id, txn.kind)) {
    throw new ReferenceRuleError(FailureCode.REFERENCE_ALREADY_REVERSED, "referência já revertida por este tipo");
  }

  const ctx = { entryId: randomUUID(), transactionId: txn.id, now };
  return txn.ledgerDirectionFor(ref) === LedgerDirection.Credit
    ? wallet.credit(txn.money, ctx)
    : wallet.debit(txn.money, ctx, "REVERSAL");
}

function toPayload(input: SubmitInput): WagerPayload {
  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    throw new InvalidSubmissionError("header Idempotency-Key é obrigatório");
  }
  const required: Array<[string, unknown]> = [
    ["providerId", input.providerId],
    ["externalTransactionId", input.externalTransactionId],
    ["roundId", input.roundId],
    ["gameId", input.gameId],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new InvalidSubmissionError(`${field} obrigatório`);
    }
  }
  if (!UUID_RE.test(input.walletId) || !UUID_RE.test(input.playerId)) {
    throw new InvalidSubmissionError("walletId e playerId devem ser UUID");
  }
  if (!Object.values(WagerTransactionKind).includes(input.kind as WagerTransactionKind)) {
    throw new InvalidSubmissionError(`kind desconhecido: ${input.kind}`);
  }
  if (input.kind === WagerTransactionKind.Opening) {
    throw new InvalidSubmissionError("OPENING é reservado ao sistema");
  }
  // Valida formato e sinal do valor (lança InvalidMoneyError se inválido).
  Money.fromInput(input.money);
  return { ...input, kind: input.kind as WagerTransactionKind };
}

/** Evento de integração do status decidido. Só PROCESSED, REJECTED e PENDING_REFERENCE geram evento (seção 11). */
function transactionEvent(txn: WagerTransaction, occurredAt: Date) {
  const snapshot: TransactionSnapshot = {
    id: txn.id,
    providerId: txn.providerId,
    externalTransactionId: txn.externalTransactionId,
    walletId: txn.walletId,
    kind: txn.kind,
    status: txn.status,
    failureCode: txn.failureCode ?? null,
  };
  const meta = { correlationId: txn.id, occurredAt };
  switch (txn.status) {
    case WagerTransactionStatus.Processed:
      return WagerTransactionProcessedEvent.from(snapshot, meta);
    case WagerTransactionStatus.Rejected:
      return WagerTransactionRejectedEvent.from(snapshot, meta);
    case WagerTransactionStatus.PendingReference:
      return WagerTransactionPendingReferenceEvent.from(snapshot, meta);
    default:
      throw new Error(`status ${txn.status} não gera evento de integração`);
  }
}

/** Repetição idempotente: devolve o resultado original, com o saldo observado naquele momento. */
function toReplayResult(row: WagerTxRow): SubmitResult {
  return {
    transactionId: row.id,
    status: row.status as WagerTransactionStatus,
    balance: Money.fromMinor(BigInt(row.balance_observed_minor ?? "0"), row.currency).toJSON(),
    idempotentReplay: true,
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
  };
}
