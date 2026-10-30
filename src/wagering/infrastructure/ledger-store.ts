import { randomUUID } from "node:crypto";
import { metrics } from "../../shared/metrics";
import type { IntegrationEvent } from "../../shared/integration-event";
import { OutboxMessage } from "../../outbox/outbox-message";
import { Money } from "../../shared/money";
import { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { FailureCode } from "../../shared/failure-code";

/**
 * Conexão DENTRO de uma transação. Vem de `em.transactional(...)` via `tx.getKnex()`.
 *
 * Atenção: NÃO usar `em.getConnection()` dentro de transactional. Essa conexão não está
 * ligada ao BEGIN, então cada query roda em autocommit e o lock FOR UPDATE é liberado na hora.
 * Foi exatamente o bug que os testes de concorrência pegaram.
 */
export interface Conn {
  raw(sql: string, bindings?: unknown[]): Promise<{ rows?: unknown[] }>;
}

/**
 * Conexão da transação ativa do MikroORM. Falha se não houver transação, para nunca
 * rodar uma query de escrita em autocommit por engano.
 */
export function transactionConn(em: { getTransactionContext(): unknown }): Conn {
  const trx = em.getTransactionContext();
  if (!trx) throw new Error("query de escrita fora de transação");
  return trx as Conn;
}

/** SELECT ou UPDATE ... RETURNING: devolve as linhas. */
export async function query<T>(conn: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await conn.raw(sql, params);
  return (result.rows ?? []) as T[];
}

/** INSERT ou UPDATE sem retorno. */
export async function run(conn: Conn, sql: string, params: unknown[] = []): Promise<void> {
  await conn.raw(sql, params);
}

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_minor: string; // bigint volta como string do driver
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface WagerTxRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount_minor: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  created_at: Date;
  processed_at: Date | null;
  balance_observed_minor: string | null;
}

/** Trava a linha da carteira até o fim da transação. Lock por walletId: nunca global. */
export async function lockWallet(conn: Conn, walletId: string): Promise<WalletRow | undefined> {
  // Mede o tempo de espera pelo lock: é o indicador de contenção por carteira (hot wallet).
  const started = performance.now();
  const rows = await query<WalletRow>(conn, "SELECT * FROM wallets WHERE id = ? FOR UPDATE", [walletId]);
  const waited = performance.now() - started;
  metrics.observe("wallet_lock_wait_ms", waited);
  // Espera acima de 50ms: a transação esperou outra pelo mesmo saldo (conflito de lock).
  if (waited > 50) metrics.inc("wallet_lock_contended_total");
  return rows[0];
}

export async function findByIdempotencyKey(conn: Conn, key: string): Promise<WagerTxRow | undefined> {
  const rows = await query<WagerTxRow>(conn, "SELECT * FROM wager_transactions WHERE idempotency_key = ?", [key]);
  return rows[0];
}

export async function findByExternalId(
  conn: Conn,
  providerId: string,
  externalTransactionId: string,
): Promise<WagerTxRow | undefined> {
  const rows = await query<WagerTxRow>(
    conn,
    "SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?",
    [providerId, externalTransactionId],
  );
  return rows[0];
}

/** Já existe uma reversão PROCESSED do mesmo tipo sobre esta referência? */
export async function hasProcessedReversal(conn: Conn, referenceId: string, kind: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    conn,
    `SELECT 1 AS n FROM wager_transactions
      WHERE reference_transaction_id = ? AND kind = ? AND status = 'PROCESSED' LIMIT 1`,
    [referenceId, kind],
  );
  return rows.length > 0;
}

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.fromMinor(BigInt(row.balance_minor), row.currency).toJSON(),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function txFromRow(row: WagerTxRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.fromMinor(BigInt(row.amount_minor), row.currency).toJSON(),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: row.created_at,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: row.processed_at ?? undefined,
  });
}

export async function insertTransaction(conn: Conn, tx: WagerTransaction, balanceObserved: Money): Promise<void> {
  await run(
    conn,
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
       reference_external_transaction_id, reference_transaction_id,
       status, failure_code, created_at, processed_at, balance_observed_minor
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tx.id,
      tx.providerId,
      tx.externalTransactionId,
      tx.idempotencyKey,
      tx.payloadHash,
      tx.walletId,
      tx.playerId,
      tx.roundId,
      tx.gameId,
      tx.kind,
      tx.money.toMinor().toString(),
      tx.money.currency,
      tx.referenceExternalTransactionId ?? null,
      tx.referenceTransactionId ?? null,
      tx.status,
      tx.failureCode ?? null,
      tx.createdAt,
      tx.processedAt ?? null,
      balanceObserved.toMinor().toString(),
    ],
  );
}

/**
 * Atualiza saldo e versão. O WHERE version = previousVersion é uma segunda barreira:
 * com o lock já adquirido isto nunca deveria falhar, mas se falhar, a transação aborta.
 */
export async function updateWallet(conn: Conn, wallet: Wallet, previousVersion: number): Promise<void> {
  const rows = await query<{ id: string }>(
    conn,
    `UPDATE wallets
        SET balance_minor = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ?
      RETURNING id`,
    [wallet.balance.toMinor().toString(), wallet.version, wallet.updatedAt, wallet.id, previousVersion],
  );
  if (rows.length !== 1) {
    throw new Error(`concorrência na wallet ${wallet.id}: versão esperada ${previousVersion}`);
  }
}

export async function insertLedger(conn: Conn, entry: WalletLedgerEntry, walletVersion: number): Promise<void> {
  await run(
    conn,
    `INSERT INTO wallet_ledger_entries (
       id, wallet_id, transaction_id, wallet_version, direction,
       amount_minor, currency, balance_before_minor, balance_after_minor, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.id,
      entry.walletId,
      entry.transactionId,
      walletVersion,
      entry.direction,
      entry.money.toMinor().toString(),
      entry.money.currency,
      entry.balanceBefore.toMinor().toString(),
      entry.balanceAfter.toMinor().toString(),
      entry.createdAt,
    ],
  );

  // Partida dobrada: a perna da casa é a contrapartida, com direção oposta, no mesmo commit.
  const houseDirection = entry.direction === LedgerDirection.Credit ? "DEBIT" : "CREDIT";
  await run(
    conn,
    `INSERT INTO house_ledger_entries (id, wallet_ledger_entry_id, transaction_id, direction, amount_minor, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      entry.id,
      entry.transactionId,
      houseDirection,
      entry.money.toMinor().toString(),
      entry.money.currency,
      entry.createdAt,
    ],
  );
}

/** Grava o evento na outbox, na mesma transação SQL da alteração que o originou. */
export async function insertOutbox(conn: Conn, event: IntegrationEvent<unknown>): Promise<void> {
  const msg = OutboxMessage.enqueue(event);
  await run(
    conn,
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
     VALUES (?, ?, ?, ?::jsonb, ?, ?)`,
    [msg.id, msg.aggregateId, msg.eventType, JSON.stringify(msg.payload), msg.occurredAt, msg.nextAttemptAt],
  );
}
