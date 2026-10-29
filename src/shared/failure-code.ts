/**
 * Taxonomia de falhas de negócio. Os valores são contrato com os provedores:
 * não renomear sem versionar a API.
 */
export enum FailureCode {
  /** Payload malformado ou violando invariantes de contrato. */
  INVALID_PAYLOAD = "INVALID_PAYLOAD",
  /** Moeda da operação diferente da moeda da wallet ou da referência. */
  CURRENCY_MISMATCH = "CURRENCY_MISMATCH",
  /** Aposta (BET) sem saldo suficiente. */
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  /** Reversão (REFUND/ROLLBACK) que deixaria o saldo negativo. Operacionalmente distinta de INSUFFICIENT_BALANCE. */
  REVERSAL_WOULD_OVERDRAW = "REVERSAL_WOULD_OVERDRAW",
  /** Wallet informada não existe. */
  WALLET_NOT_FOUND = "WALLET_NOT_FOUND",
  /** Referência não apareceu dentro do limite de tentativas/TTL. */
  REFERENCE_NOT_FOUND = "REFERENCE_NOT_FOUND",
  /** Referência existe mas não está PROCESSED. */
  REFERENCE_NOT_PROCESSED = "REFERENCE_NOT_PROCESSED",
  /** Tipo da referência não é permitido para a operação (ex.: REFUND referenciando WIN). */
  REFERENCE_KIND_NOT_ALLOWED = "REFERENCE_KIND_NOT_ALLOWED",
  /** Referência já foi revertida pelo mesmo tipo de operação. */
  REFERENCE_ALREADY_REVERSED = "REFERENCE_ALREADY_REVERSED",
  /** Valor da reversão diferente do valor da referência (reversão parcial fora de escopo). */
  REFERENCE_AMOUNT_MISMATCH = "REFERENCE_AMOUNT_MISMATCH",
  /** Referência pertence a outro provider, jogador, wallet ou rodada. */
  REFERENCE_CONTEXT_MISMATCH = "REFERENCE_CONTEXT_MISMATCH",
  /** Transação interna (OPENING) submetida por canal externo. */
  INTERNAL_KIND_NOT_ALLOWED = "INTERNAL_KIND_NOT_ALLOWED",
  /** Falha permanente de infraestrutura registrada como transação FAILED. */
  PERMANENT_INFRA_FAILURE = "PERMANENT_INFRA_FAILURE",
}

export type FailureAction = "RETRY" | "FIX_PAYLOAD" | "GIVE_UP";

export interface FailureDescriptor {
  /** O que o provedor deve fazer com esta rejeição. */
  action: FailureAction;
  description: string;
}

export const FAILURE_CATALOG: Record<FailureCode, FailureDescriptor> = {
  [FailureCode.INVALID_PAYLOAD]: { action: "FIX_PAYLOAD", description: "Payload inválido; corrigir antes de reenviar." },
  [FailureCode.CURRENCY_MISMATCH]: { action: "FIX_PAYLOAD", description: "Moeda diferente da wallet ou da referência." },
  [FailureCode.INSUFFICIENT_BALANCE]: { action: "GIVE_UP", description: "Saldo insuficiente para a aposta." },
  [FailureCode.REVERSAL_WOULD_OVERDRAW]: { action: "GIVE_UP", description: "Reversão deixaria o saldo negativo; exige análise operacional." },
  [FailureCode.WALLET_NOT_FOUND]: { action: "FIX_PAYLOAD", description: "Wallet inexistente." },
  [FailureCode.REFERENCE_NOT_FOUND]: { action: "RETRY", description: "Referência ainda não recebida; reenviar depois, dentro do TTL." },
  [FailureCode.REFERENCE_NOT_PROCESSED]: { action: "RETRY", description: "Referência ainda não aplicada." },
  [FailureCode.REFERENCE_KIND_NOT_ALLOWED]: { action: "FIX_PAYLOAD", description: "Tipo de operação não pode referenciar esse tipo." },
  [FailureCode.REFERENCE_ALREADY_REVERSED]: { action: "GIVE_UP", description: "Referência já revertida por este tipo de operação." },
  [FailureCode.REFERENCE_AMOUNT_MISMATCH]: { action: "FIX_PAYLOAD", description: "Valor diferente da referência." },
  [FailureCode.REFERENCE_CONTEXT_MISMATCH]: { action: "FIX_PAYLOAD", description: "Referência de outro provider, jogador, wallet ou rodada." },
  [FailureCode.INTERNAL_KIND_NOT_ALLOWED]: { action: "GIVE_UP", description: "Tipo reservado ao sistema." },
  [FailureCode.PERMANENT_INFRA_FAILURE]: { action: "GIVE_UP", description: "Falha permanente; transação registrada para auditoria." },
};
