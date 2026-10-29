import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/shared/failure-code";
import { Money } from "../../src/shared/money";
import { LedgerDirection } from "../../src/wallet/domain/wallet-ledger-entry";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerPayload,
} from "../../src/wagering/domain/wager-transaction";

const now = new Date("2026-07-29T15:00:00.000Z");

function payload(overrides: Partial<WagerPayload> = {}): WagerPayload {
  return {
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

function make(overrides: Partial<WagerPayload> = {}, id = "internal-1"): WagerTransaction {
  return WagerTransaction.create({ id, payload: payload(overrides), now });
}

describe("WagerTransaction criação", () => {
  test("nasce PENDING com idempotencyKey padrão {providerId}:{externalTransactionId}", () => {
    const tx = make();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.idempotencyKey).toBe("provider-a:tx-1");
    expect(tx.payloadHash).toHaveLength(64);
  });

  test("OPENING não pode ser criada por canal externo", () => {
    expect(() => make({ kind: WagerTransactionKind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test("OPENING interna é criada pelo factory openingFor", () => {
    const tx = WagerTransaction.openingFor({
      id: "open-1",
      walletId: "wallet-1",
      playerId: "player-1",
      money: Money.fromInput({ amount: "1000.00", currency: "BRL" }),
      now,
    });
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("REFUND e ROLLBACK exigem referência", () => {
    expect(() => make({ kind: WagerTransactionKind.Refund })).toThrow(InvalidWagerTransactionError);
    expect(() => make({ kind: WagerTransactionKind.Rollback })).toThrow(InvalidWagerTransactionError);
  });

  test("BET e LOSS não aceitam referência", () => {
    expect(() => make({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: "x" })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => make({ kind: WagerTransactionKind.Loss, referenceExternalTransactionId: "x" })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("WIN aceita referência opcional", () => {
    expect(() => make({ kind: WagerTransactionKind.Win })).not.toThrow();
    expect(() => make({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: "tx-bet" })).not.toThrow();
  });

  test("BET com valor zero é rejeitada, LOSS com valor zero é aceita", () => {
    expect(() => make({ money: { amount: "0.00", currency: "BRL" } })).toThrow(InvalidWagerTransactionError);
    expect(() =>
      make({ kind: WagerTransactionKind.Loss, money: { amount: "0.00", currency: "BRL" } }),
    ).not.toThrow();
  });

  test("valor com formato inválido é rejeitado na entrada", () => {
    expect(() => make({ money: { amount: "25.5", currency: "BRL" } })).toThrow();
  });
});

describe("WagerTransaction transições", () => {
  test("PENDING -> PENDING_REFERENCE -> PROCESSED", () => {
    const tx = make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "tx-bet" });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    tx.markPendingReference(); // worker reavaliando
    tx.markProcessed("internal-bet-id", now);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe("internal-bet-id");
    expect(tx.processedAt).toEqual(now);
  });

  test("PROCESSED é terminal: qualquer nova transição lança erro", () => {
    const tx = make();
    tx.markProcessed(undefined, now);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.INSUFFICIENT_BALANCE)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.PERMANENT_INFRA_FAILURE)).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  test("REJECTED é terminal e guarda o failureCode", () => {
    const tx = make();
    tx.reject(FailureCode.INSUFFICIENT_BALANCE);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
  });

  test("FAILED é terminal e auditável", () => {
    const tx = make();
    tx.fail(FailureCode.PERMANENT_INFRA_FAILURE);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.PERMANENT_INFRA_FAILURE);
    expect(() => tx.reject(FailureCode.INVALID_PAYLOAD)).toThrow(InvalidTransactionStateError);
  });

  test("REFUND não pode ser processada sem referência resolvida", () => {
    const tx = make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "tx-bet" });
    expect(() => tx.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });
});

describe("WagerTransaction consultas de domínio", () => {
  test("LOSS não afeta saldo", () => {
    expect(make({ kind: WagerTransactionKind.Loss, money: { amount: "0.00", currency: "BRL" } }).affectsBalance()).toBe(false);
    expect(make().affectsBalance()).toBe(true);
  });

  test("requiresReference é verdadeiro só para REFUND e ROLLBACK", () => {
    expect(make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "b" }).requiresReference()).toBe(true);
    expect(make({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "b" }).requiresReference()).toBe(true);
    expect(make().requiresReference()).toBe(false);
  });

  test("direção do lançamento por tipo", () => {
    expect(make({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "b" }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a direção da referência", () => {
    const bet = make({}, "bet-internal");
    const win = make({ kind: WagerTransactionKind.Win, externalTransactionId: "tx-win" }, "win-internal");
    const rollback = make({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "tx-1" }, "rb-1");
    const rollbackWin = make(
      { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "tx-win", externalTransactionId: "tx-rb2" },
      "rb-2",
    );

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit); // reverte débito
    expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit); // reverte crédito
  });

  test("ROLLBACK sem a referência não define direção", () => {
    const rollback = make({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "tx-1" });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS não gera lançamento", () => {
    expect(() => make({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});

describe("payloadHash", () => {
  test("é estável e ignora a ordem das chaves do payload", () => {
    const a = WagerTransaction.computePayloadHash(payload());
    const reordered = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: "wallet-1",
      playerId: "player-1",
      externalTransactionId: "tx-1",
      providerId: "provider-a",
    } as unknown as WagerPayload;
    expect(WagerTransaction.computePayloadHash(reordered)).toBe(a);
  });

  test("muda quando qualquer campo de negócio muda", () => {
    const base = WagerTransaction.computePayloadHash(payload());
    expect(WagerTransaction.computePayloadHash(payload({ money: { amount: "25.01", currency: "BRL" } }))).not.toBe(base);
    expect(WagerTransaction.computePayloadHash(payload({ roundId: "round-988" }))).not.toBe(base);
  });

  test("matchesPayload detecta payload divergente (conflito, não replay)", () => {
    const tx = make();
    expect(tx.matchesPayload(WagerTransaction.computePayloadHash(payload()))).toBe(true);
    const divergent = WagerTransaction.computePayloadHash(payload({ money: { amount: "30.00", currency: "BRL" } }));
    expect(tx.matchesPayload(divergent)).toBe(false);
  });
});
