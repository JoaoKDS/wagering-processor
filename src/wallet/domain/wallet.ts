import { DomainError } from "../../shared/domain-error";
import { FailureCode } from "../../shared/failure-code";
import { CurrencyMismatchError, InvalidMoneyError, Money, type MoneyProps } from "../../shared/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export class InsufficientBalanceError extends DomainError {
  readonly failureCode = FailureCode.INSUFFICIENT_BALANCE;
}

export class ReversalWouldOverdrawError extends DomainError {
  readonly failureCode = FailureCode.REVERSAL_WOULD_OVERDRAW;
}

export interface MovementContext {
  /** Id do lançamento gerado (o chamador fornece, para manter o domínio determinístico). */
  entryId: string;
  /** Transação que originou a movimentação. */
  transactionId: string;
  now: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. Toda alteração de saldo passa por credit/debit, que devolvem
 * o lançamento correspondente. Saldo e ledger nunca divergem dentro do domínio.
 *
 * Concorrência NÃO é resolvida aqui: o controle de concorrência (SELECT ... FOR UPDATE por
 * walletId) fica na camada de persistência/aplicação. Este objeto só garante as invariantes
 * sobre o estado que recebe.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma wallet. Se o saldo inicial for positivo, devolve também o lançamento CREDIT
   * de abertura, que deve ser persistido junto com a transação OPENING.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingEntryId: string;
    openingTransactionId: string;
    now: Date;
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | null } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("saldo inicial não pode ser negativo");
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.now, props.now);

    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: null };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      createdAt: props.now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência. Não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  credit(amount: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovement(amount);
    const before = this._balance;
    const after = before.add(amount);
    return this.apply(LedgerDirection.Credit, amount, before, after, ctx);
  }

  /**
   * Débito. O motivo define o erro: BET sem saldo gera INSUFFICIENT_BALANCE;
   * reversão que deixaria saldo negativo gera REVERSAL_WOULD_OVERDRAW.
   */
  debit(amount: Money, ctx: MovementContext, reason: "BET" | "REVERSAL"): WalletLedgerEntry {
    this.assertMovement(amount);
    const before = this._balance;
    const after = before.subtract(amount);
    if (after.isNegative()) {
      throw reason === "BET"
        ? new InsufficientBalanceError("saldo insuficiente para a aposta")
        : new ReversalWouldOverdrawError("reversão deixaria o saldo negativo");
    }
    return this.apply(LedgerDirection.Debit, amount, before, after, ctx);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON(),
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    before: Money,
    after: Money,
    ctx: MovementContext,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: ctx.now,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ctx.now;
    return entry;
  }

  private assertMovement(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(`moeda ${amount.currency} diferente da wallet ${this.currency}`);
    }
    if (!amount.isPositive()) {
      throw new InvalidMoneyError("movimentação precisa ser positiva");
    }
  }
}
