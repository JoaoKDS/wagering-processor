import { IntegrationEvent, type IntegrationEventProps } from "../shared/integration-event";
import type { WalletLedgerEntry } from "../wallet/domain/wallet-ledger-entry";

// ---------- eventos de wallet ----------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: string;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  walletVersion: number;
}

export interface EventMeta {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  eventId?: string;
}

/** Publicado somente quando o saldo muda (spec, seção 11). */
export class WalletBalanceChangedEvent extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(entry: WalletLedgerEntry, walletVersion: number, meta: EventMeta): WalletBalanceChangedEvent {
    const props: IntegrationEventProps<WalletBalanceChangedData> = {
      ...meta,
      aggregateId: entry.walletId,
      data: {
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion,
      },
    };
    return new WalletBalanceChangedEvent(props);
  }
}

// ---------- eventos de transação ----------

/** Estado mínimo de uma transação para montar o evento. Não depende do aggregate nem do ORM. */
export interface TransactionSnapshot {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  failureCode: string | null;
}

export interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  failureCode: string | null;
}

function toTransactionData(t: TransactionSnapshot, status: string, failureCode: string | null): TransactionEventData {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    kind: t.kind,
    status,
    failureCode,
  };
}

/** Transação aplicada, inclusive LOSS (spec, seção 11). */
export class WagerTransactionProcessedEvent extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(t: TransactionSnapshot, meta: EventMeta): WagerTransactionProcessedEvent {
    return new WagerTransactionProcessedEvent({
      ...meta,
      aggregateId: t.id,
      data: toTransactionData(t, "PROCESSED", null),
    });
  }
}

/** Rejeição por regra de negócio (spec, seção 11). */
export class WagerTransactionRejectedEvent extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(t: TransactionSnapshot, meta: EventMeta): WagerTransactionRejectedEvent {
    return new WagerTransactionRejectedEvent({
      ...meta,
      aggregateId: t.id,
      data: toTransactionData(t, "REJECTED", t.failureCode),
    });
  }
}

/** Referência ausente: a transação fica aguardando (spec, seção 11). */
export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(t: TransactionSnapshot, meta: EventMeta): WagerTransactionPendingReferenceEvent {
    return new WagerTransactionPendingReferenceEvent({
      ...meta,
      aggregateId: t.id,
      data: toTransactionData(t, "PENDING_REFERENCE", null),
    });
  }
}
