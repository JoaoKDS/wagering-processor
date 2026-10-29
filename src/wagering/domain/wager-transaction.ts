import { canonicalHash } from "../../shared/canonical-hash";
import { DomainError } from "../../shared/domain-error";
import { FailureCode } from "../../shared/failure-code";
import { Money, type MoneyProps } from "../../shared/money";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca vem da API nem da fila. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = "PENDING",
  /** Aguardando a transação referenciada. */
  PendingReference = "PENDING_REFERENCE",
  /** Aplicada. Terminal. */
  Processed = "PROCESSED",
  /** Violação de regra de negócio. Terminal. */
  Rejected = "REJECTED",
  /** Erro permanente de infraestrutura, auditável. Terminal. */
  Failed = "FAILED",
}

/**
 * Transições válidas. Estados terminais não têm saída: tentar transicioná-los é erro de programação.
 * PENDING_REFERENCE -> PENDING_REFERENCE existe para o worker que reavalia a referência.
 */
const TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Campos de negócio enviados pelo provedor. Entram no payloadHash. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Id externo da transação referenciada (no provedor, não o id interno). */
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends WagerPayload {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class InvalidTransactionStateError extends Error {}

export class InvalidWagerTransactionError extends DomainError {
  readonly failureCode = FailureCode.INVALID_PAYLOAD;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
  ) {}

  /** Cria uma transação externa. Nasce PENDING. OPENING é rejeitado aqui. */
  static create(props: { id: string; payload: WagerPayload; idempotencyKey?: string; now: Date }): WagerTransaction {
    if (props.payload.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING é reservado ao sistema");
    }
    return WagerTransaction.build(props.id, props.payload, props.idempotencyKey, props.now);
  }

  /** Cria a transação interna de abertura de uma wallet. */
  static openingFor(props: { id: string; walletId: string; playerId: string; money: Money; now: Date }): WagerTransaction {
    const payload: WagerPayload = {
      providerId: "INTERNAL",
      externalTransactionId: `opening:${props.walletId}`,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: "opening",
      gameId: "internal",
      kind: WagerTransactionKind.Opening,
      money: props.money.toJSON(),
    };
    return WagerTransaction.build(props.id, payload, undefined, props.now);
  }

  /** Reidratação a partir da persistência. Não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  /**
   * Hash do subconjunto de campos de negócio em forma canônica.
   * Usa o money normalizado para que "25.00" e "25.0" (se chegasse) não gerem hashes diferentes.
   */
  static computePayloadHash(payload: WagerPayload): string {
    return canonicalHash({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: Money.fromInput(payload.money).toJSON(),
      referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markPendingReference(): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} só pode ser processada com a referência resolvida`);
    }
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  reject(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. ROLLBACK inverte a direção da referência, então exige a referência.
   * A regra de quais tipos podem referenciar quais é validada na camada de aplicação.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS não gera lançamento");
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError("ROLLBACK exige a transação referenciada");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Credit
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
      }
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
    };
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`transição ${this._status} -> ${next} não permitida`);
    }
    this._status = next;
  }

  private static build(
    id: string,
    payload: WagerPayload,
    idempotencyKey: string | undefined,
    now: Date,
  ): WagerTransaction {
    const money = Money.fromInput(payload.money);
    WagerTransaction.validate(payload, money);

    return new WagerTransaction(
      id,
      payload.providerId,
      payload.externalTransactionId,
      idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`,
      WagerTransaction.computePayloadHash(payload),
      payload.walletId,
      payload.playerId,
      payload.roundId,
      payload.gameId,
      payload.kind,
      money,
      payload.referenceExternalTransactionId,
      now,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
    );
  }

  private static validate(payload: WagerPayload, money: Money): void {
    const requiredText: Array<[string, string]> = [
      ["providerId", payload.providerId],
      ["externalTransactionId", payload.externalTransactionId],
      ["playerId", payload.playerId],
      ["walletId", payload.walletId],
      ["roundId", payload.roundId],
      ["gameId", payload.gameId],
    ];
    for (const [field, value] of requiredText) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidWagerTransactionError(`${field} obrigatório`);
      }
    }

    const ref = payload.referenceExternalTransactionId;
    switch (payload.kind) {
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        if (!ref) throw new InvalidWagerTransactionError(`${payload.kind} exige referenceExternalTransactionId`);
        break;
      case WagerTransactionKind.Win:
        break; // referência opcional
      default:
        if (ref !== undefined) {
          throw new InvalidWagerTransactionError(`${payload.kind} não aceita referência`);
        }
    }

    if (payload.kind === WagerTransactionKind.Loss) {
      return; // LOSS pode ter valor zero: não move saldo
    }
    if (!money.isPositive()) {
      throw new InvalidWagerTransactionError(`${payload.kind} exige valor positivo`);
    }
  }
}
