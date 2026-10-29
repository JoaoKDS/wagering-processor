import type { MikroORM } from "@mikro-orm/postgresql";
import type { MoneyProps } from "../../shared/money";
import { Money } from "../../shared/money";

/**
 * Leituras fora de transação. Não tomam lock: retornam o último estado commitado.
 * Usam a conexão do pool diretamente, porque nenhuma escrita acontece aqui.
 */
export class WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  private get db() {
    return this.orm.em.getConnection();
  }

  async wallet(walletId: string): Promise<WalletView | undefined> {
    const rows = await this.db.execute<WalletRow[]>(
      "SELECT id, player_id, currency, balance_minor, version FROM wallets WHERE id = ?",
      [walletId],
    );
    return rows[0] ? toWalletView(rows[0]) : undefined;
  }

  /** Paginação por cursor opaco: a versão da wallet do último lançamento devolvido. */
  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage | undefined> {
    if (!(await this.wallet(walletId))) return undefined;
    const before = cursor ? decodeCursor(cursor) : Number.MAX_SAFE_INTEGER;
    const rows = await this.db.execute<LedgerRow[]>(
      `SELECT wallet_version, transaction_id, direction, amount_minor, currency,
              balance_before_minor, balance_after_minor, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND wallet_version < ?
        ORDER BY wallet_version DESC
        LIMIT ?`,
      [walletId, before, limit],
    );
    const entries = rows.map(toLedgerView);
    const last = rows.at(-1);
    return {
      entries,
      nextCursor: rows.length === limit && last ? encodeCursor(last.wallet_version) : null,
    };
  }

  async transactionById(transactionId: string): Promise<TransactionView | undefined> {
    const rows = await this.db.execute<TxRow[]>(`${TX_SELECT} WHERE id = ?`, [transactionId]);
    return rows[0] ? toTransactionView(rows[0]) : undefined;
  }

  async transactionByExternalId(providerId: string, externalId: string): Promise<TransactionView | undefined> {
    const rows = await this.db.execute<TxRow[]>(
      `${TX_SELECT} WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalId],
    );
    return rows[0] ? toTransactionView(rows[0]) : undefined;
  }

  /** Recalcula o saldo a partir do ledger e compara com o armazenado. Não corrige nada. */
  async reconcile(walletId: string): Promise<ReconciliationView | undefined> {
    const wallet = await this.wallet(walletId);
    if (!wallet) return undefined;
    const [row] = await this.db.execute<{ calc: string; n: number }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::text AS calc,
              count(*)::int AS n
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const stored = Money.fromMinor(BigInt(wallet.balanceMinor), wallet.currency);
    const calculated = Money.fromMinor(BigInt(row?.calc ?? "0"), wallet.currency);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      // Divergência é sinalizada, nunca corrigida em silêncio.
      console.warn(JSON.stringify({ level: "error", event: "wallet_reconciliation_mismatch", walletId }));
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: row?.n ?? 0,
    };
  }

  /** Idade, em segundos, do evento de outbox mais antigo ainda não publicado. 0 se a fila está vazia. */
  async outboxLagSeconds(): Promise<number> {
    const rows = await this.db.execute<{ lag: string | null }[]>(
      "SELECT EXTRACT(EPOCH FROM (now() - min(occurred_at)))::text AS lag FROM outbox_messages WHERE published_at IS NULL",
    );
    return Number(rows[0]?.lag ?? 0) || 0;
  }

  /** Readiness: alcança o PostgreSQL. */
  async ping(): Promise<boolean> {
    try {
      await this.db.execute("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}

// ---------- tipos e mapeamentos ----------

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  balanceMinor: string;
  currency: string;
}

export interface LedgerView {
  version: number;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface LedgerPage {
  entries: LedgerView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceTransactionId: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

const TX_SELECT = `SELECT id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id,
                          kind, amount_minor, currency, status, failure_code, reference_transaction_id,
                          created_at, processed_at
                     FROM wager_transactions`;

interface TxRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount_minor: string;
  currency: string;
  status: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
  created_at: Date;
  processed_at: Date | null;
}

function toTransactionView(row: TxRow): TransactionView {
  return {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.fromMinor(BigInt(row.amount_minor), row.currency).toJSON(),
    status: row.status,
    failureCode: row.failure_code,
    referenceTransactionId: row.reference_transaction_id,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_minor: string;
  version: number;
}

interface LedgerRow {
  wallet_version: number;
  transaction_id: string;
  direction: string;
  amount_minor: string;
  currency: string;
  balance_before_minor: string;
  balance_after_minor: string;
  created_at: Date;
}

function toWalletView(row: WalletRow): WalletView {
  const money = Money.fromMinor(BigInt(row.balance_minor), row.currency);
  return {
    id: row.id,
    playerId: row.player_id,
    balance: money.toJSON(),
    version: row.version,
    balanceMinor: row.balance_minor,
    currency: row.currency,
  };
}

function toLedgerView(row: LedgerRow): LedgerView {
  return {
    version: row.wallet_version,
    transactionId: row.transaction_id,
    direction: row.direction,
    money: Money.fromMinor(BigInt(row.amount_minor), row.currency).toJSON(),
    balanceBefore: Money.fromMinor(BigInt(row.balance_before_minor), row.currency).toJSON(),
    balanceAfter: Money.fromMinor(BigInt(row.balance_after_minor), row.currency).toJSON(),
    createdAt: row.created_at,
  };
}

function encodeCursor(version: number): string {
  return Buffer.from(String(version)).toString("base64url");
}

function decodeCursor(cursor: string): number {
  // Só aceita base64url que decodifica para dígitos. Sem isso, "%%%" vira "" e depois 0.
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(text)) {
    throw new Error("cursor inválido");
  }
  return Number(text);
}
