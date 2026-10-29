import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../../src/shared/money";
import { FailureCode } from "../../src/shared/failure-code";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import {
  InsufficientBalanceError,
  ReversalWouldOverdrawError,
  Wallet,
  type MovementContext,
} from "../../src/wallet/domain/wallet";

const now = new Date("2026-07-29T15:00:00.000Z");
const brl = (amount: string) => Money.fromInput({ amount, currency: "BRL" });

let seq = 0;
function ctx(): MovementContext {
  seq += 1;
  return { entryId: `entry-${seq}`, transactionId: `tx-${seq}`, now };
}

function openWallet(initial: string): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initial),
    openingEntryId: "entry-open",
    openingTransactionId: "tx-open",
    now,
  }).wallet;
}

describe("Wallet.open", () => {
  test("com saldo inicial: version 1 e lançamento CREDIT balanceado", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("1000.00"),
      openingEntryId: "entry-open",
      openingTransactionId: "tx-open",
      now,
    });

    expect(wallet.balance.toJSON().amount).toBe("1000.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry).not.toBeNull();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.isBalanced()).toBe(true);
    expect(openingEntry!.balanceBefore.isZero()).toBe(true);
    expect(openingEntry!.balanceAfter.toJSON().amount).toBe("1000.00");
  });

  test("com saldo zero: não gera lançamento de abertura", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("0.00"),
      openingEntryId: "entry-open",
      openingTransactionId: "tx-open",
      now,
    });
    expect(openingEntry).toBeNull();
    expect(wallet.version).toBe(1);
  });

  test("rejeita saldo inicial negativo", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: Money.from({ amount: "-1.00", currency: "BRL" }),
        openingEntryId: "e",
        openingTransactionId: "t",
        now,
      }),
    ).toThrow();
  });
});

describe("Wallet credit/debit", () => {
  test("crédito aumenta saldo, incrementa version e devolve lançamento CREDIT", () => {
    const wallet = openWallet("10.00");
    const entry = wallet.credit(brl("5.00"), ctx());

    expect(wallet.balance.toJSON().amount).toBe("15.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test("débito diminui saldo e devolve lançamento DEBIT balanceado", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(brl("25.00"), ctx(), "BET");

    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
  });

  test("débito exato até zero é permitido", () => {
    const wallet = openWallet("80.00");
    wallet.debit(brl("80.00"), ctx(), "BET");
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("aposta sem saldo: InsufficientBalanceError, sem alterar saldo nem version", () => {
    const wallet = openWallet("100.00");
    let caught: unknown;
    try {
      wallet.debit(brl("100.01"), ctx(), "BET");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InsufficientBalanceError);
    expect((caught as InsufficientBalanceError).failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("reversão que deixaria saldo negativo: código distinto de aposta sem saldo", () => {
    const wallet = openWallet("10.00");
    let caught: unknown;
    try {
      wallet.debit(brl("25.00"), ctx(), "REVERSAL");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReversalWouldOverdrawError);
    expect((caught as ReversalWouldOverdrawError).failureCode).toBe(FailureCode.REVERSAL_WOULD_OVERDRAW);
    expect(wallet.balance.toJSON().amount).toBe("10.00");
  });

  test("movimentação em moeda diferente da wallet lança CurrencyMismatchError", () => {
    const wallet = openWallet("10.00");
    const usd = Money.fromInput({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit(usd, ctx())).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, ctx(), "BET")).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("movimentação zero ou negativa é rejeitada", () => {
    const wallet = openWallet("10.00");
    expect(() => wallet.credit(brl("0.00"), ctx())).toThrow();
    expect(() => wallet.debit(Money.from({ amount: "-1.00", currency: "BRL" }), ctx(), "BET")).toThrow();
    expect(wallet.version).toBe(1);
  });

  test("duas apostas de 80 sobre saldo de 100: a segunda é rejeitada", () => {
    const wallet = openWallet("100.00");
    wallet.debit(brl("80.00"), ctx(), "BET");
    expect(() => wallet.debit(brl("80.00"), ctx(), "BET")).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("toState/rehydrate preservam saldo e version", () => {
    const wallet = openWallet("42.00");
    wallet.credit(brl("8.00"), ctx());
    const restored = Wallet.rehydrate(wallet.toState());
    expect(restored.balance.toJSON().amount).toBe("50.00");
    expect(restored.version).toBe(2);
  });
});
