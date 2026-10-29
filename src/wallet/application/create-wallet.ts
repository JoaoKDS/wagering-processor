import type { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { Money, type MoneyProps } from "../../shared/money";
import { Wallet } from "../domain/wallet";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import {
  insertLedger,
  insertOutbox,
  insertTransaction,
  run,
  transactionConn,
} from "../../wagering/infrastructure/ledger-store";
import { InvalidSubmissionError } from "../../wagering/application/submit-wager-transaction";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cria a wallet. Se o saldo inicial for positivo, grava também a transação OPENING e o
 * lançamento CREDIT correspondente, tudo na mesma transação SQL.
 */
export class CreateWallet {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    if (typeof input.playerId !== "string" || !UUID_RE.test(input.playerId)) {
      throw new InvalidSubmissionError("playerId deve ser UUID");
    }
    const money = Money.fromInput(input.initialBalance);
    const now = this.clock();
    const walletId = randomUUID();
    const openingTxId = randomUUID();

    return this.orm.em.fork().transactional(async (tx) => {
      const conn = transactionConn(tx);
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: input.playerId,
        initialBalance: money,
        openingEntryId: randomUUID(),
        openingTransactionId: openingTxId,
        now,
      });

      await run(
        conn,
        `INSERT INTO wallets (id, player_id, currency, balance_minor, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toMinor().toString(), wallet.version, now, now],
      );

      if (openingEntry) {
        const opening = WagerTransaction.openingFor({
          id: openingTxId,
          walletId,
          playerId: input.playerId,
          money,
          now,
        });
        opening.markProcessed(undefined, now);
        await insertTransaction(conn, opening, wallet.balance);
        await insertLedger(conn, openingEntry, wallet.version);
        await insertOutbox(conn, {
          aggregateId: wallet.id,
          eventType: "WalletBalanceChanged",
          occurredAt: now,
          payload: {
            walletId: wallet.id,
            transactionId: openingTxId,
            direction: openingEntry.direction,
            money: openingEntry.money.toJSON(),
            balanceBefore: openingEntry.balanceBefore.toJSON(),
            balanceAfter: openingEntry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        });
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
