import type { MikroORM } from "@mikro-orm/postgresql";
import { DomainError } from "../../shared/domain-error";
import { FailureCode } from "../../shared/failure-code";
import { applyReversal } from "./submit-wager-transaction";
import { metrics } from "../../shared/metrics";
import {
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
  type TransactionSnapshot,
} from "../../events/integration-events";
import {
  type Conn,
  type WagerTxRow,
  findByExternalId,
  insertLedger,
  insertOutbox,
  lockWallet,
  query,
  run,
  transactionConn,
  txFromRow,
  updateWallet,
  walletFromRow,
} from "../infrastructure/ledger-store";

/**
 * Referência fora de ordem: a transação espera a referência por até 24h.
 * Depois disso é rejeitada com REFERENCE_NOT_FOUND, para o provedor saber que deve desistir.
 * (Justificativa: provedores costumam reenviar em minutos; 24h cobre atrasos de fila sem deixar
 * transação pendente indefinidamente.)
 */
export const PENDING_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_BATCH_SIZE = 50;

export interface ReprocessStats {
  processed: number;
  rejected: number;
  stillPending: number;
}

/**
 * Reavalia PENDING_REFERENCE. Cada linha é travada com SKIP LOCKED (várias instâncias podem rodar)
 * e a carteira é travada com FOR UPDATE, então a regra de negócio é a mesma do caminho HTTP/fila.
 */
export async function reprocessPendingReferences(
  orm: MikroORM,
  now: Date,
  ttlMs = PENDING_REFERENCE_TTL_MS,
): Promise<ReprocessStats> {
  const stats: ReprocessStats = { processed: 0, rejected: 0, stillPending: 0 };

  await orm.em.fork().transactional(async (tx) => {
    const conn = transactionConn(tx);
    const rows = await query<WagerTxRow>(
      conn,
      `SELECT * FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND (next_attempt_at IS NULL OR next_attempt_at <= CAST(? AS timestamptz))
        ORDER BY created_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, PENDING_BATCH_SIZE],
    );

    for (const row of rows) {
      const walletRow = await lockWallet(conn, row.wallet_id);
      if (!walletRow) {
        stats.stillPending++;
        continue;
      }
      const wallet = walletFromRow(walletRow);
      const txn = txFromRow(row);
      const ref = await findByExternalId(conn, row.provider_id, row.reference_external_transaction_id ?? "");

      if (!ref) {
        if (now.getTime() - new Date(row.created_at).getTime() > ttlMs) {
          await rejectPending(conn, row, FailureCode.REFERENCE_NOT_FOUND, now);
          stats.rejected++;
        } else {
          // Backoff exponencial por transação: 1s, 2s, 4s... limitado a 1h entre tentativas (seção 7.1).
          await run(
            conn,
            `UPDATE wager_transactions
                SET reference_attempts = reference_attempts + 1,
                    next_attempt_at = CAST(? AS timestamptz) + (LEAST(power(2, reference_attempts), 3600) * interval '1 second')
              WHERE id = ?`,
            [now, row.id],
          );
          stats.stillPending++;
        }
        continue;
      }

      const previousVersion = wallet.version;
      try {
        const entry = await applyReversal(conn, wallet, txn, txFromRow(ref), now);
        await updateWallet(conn, wallet, previousVersion);
        await insertLedger(conn, entry, wallet.version);
        await run(
          conn,
          "UPDATE wager_transactions SET status = 'PROCESSED', reference_transaction_id = ?, processed_at = ? WHERE id = ?",
          [ref.id, now, row.id],
        );
        await insertOutbox(conn, WalletBalanceChangedEvent.from(entry, wallet.version, { correlationId: row.id, occurredAt: now }));
        await insertOutbox(
          conn,
          WagerTransactionProcessedEvent.from(snapshotOf(row, "PROCESSED", null), { correlationId: row.id, occurredAt: now }),
        );
        stats.processed++;
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        await rejectPending(conn, row, err.failureCode, now);
        stats.rejected++;
      }
    }
  });

  metrics.inc("pending_reference_processed_total", {}, stats.processed);
  metrics.inc("pending_reference_rejected_total", {}, stats.rejected);
  return stats;
}

async function rejectPending(conn: Conn, row: WagerTxRow, code: FailureCode, now: Date): Promise<void> {
  await run(conn, "UPDATE wager_transactions SET status = 'REJECTED', failure_code = ? WHERE id = ?", [code, row.id]);
  await insertOutbox(
    conn,
    WagerTransactionRejectedEvent.from(snapshotOf(row, "REJECTED", code), { correlationId: row.id, occurredAt: now }),
  );
}

/** Estado da transação no formato usado pelos eventos, a partir da linha lida do banco. */
function snapshotOf(row: WagerTxRow, status: string, failureCode: string | null): TransactionSnapshot {
  return {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    walletId: row.wallet_id,
    kind: row.kind,
    status,
    failureCode,
  };
}
