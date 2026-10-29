import { HttpException, HttpStatus } from "@nestjs/common";
import { DomainError } from "../shared/domain-error";
import {
  IdempotencyConflictError,
  InvalidSubmissionError,
  WalletNotFoundError,
} from "../wagering/application/submit-wager-transaction";
import { InvalidWagerTransactionError } from "../wagering/domain/wager-transaction";

/**
 * Mapeamento único de erros para HTTP. Cada situação tem um status e um código estável,
 * para o provedor decidir se reenvia, corrige o payload ou desiste, sem interpretar texto.
 *
 * 400 INVALID_PAYLOAD            payload inválido, corrigir antes de reenviar
 * 404 WALLET_NOT_FOUND           wallet inexistente
 * 409 IDEMPOTENCY_CONFLICT       mesma key com payload diferente
 * 409 WALLET_ALREADY_EXISTS      jogador já tem wallet nessa moeda
 * 422 (no corpo de resposta)     rejeição de regra de negócio, ver failureCode
 * 503 TRANSIENT_UNAVAILABLE      falha transitória, pode reenviar
 * 500 INTERNAL_ERROR             falha não prevista
 */
export function toHttpException(err: unknown): HttpException {
  if (err instanceof HttpException) return err;

  if (err instanceof InvalidSubmissionError || err instanceof InvalidWagerTransactionError || err instanceof DomainError) {
    return new HttpException({ code: "INVALID_PAYLOAD", message: (err as Error).message }, HttpStatus.BAD_REQUEST);
  }
  if (err instanceof WalletNotFoundError) {
    return new HttpException({ code: "WALLET_NOT_FOUND", message: "wallet inexistente" }, HttpStatus.NOT_FOUND);
  }
  if (err instanceof IdempotencyConflictError) {
    return new HttpException(
      { code: "IDEMPOTENCY_CONFLICT", message: "mesma Idempotency-Key com payload diferente" },
      HttpStatus.CONFLICT,
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("wallets_player_currency_uq")) {
    return new HttpException(
      { code: "WALLET_ALREADY_EXISTS", message: "jogador já tem wallet nesta moeda" },
      HttpStatus.CONFLICT,
    );
  }
  if (message.includes("concorrência na wallet") || /ECONNREFUSED|connection|timeout/i.test(message)) {
    return new HttpException(
      { code: "TRANSIENT_UNAVAILABLE", message: "falha transitória, pode reenviar" },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  console.error(JSON.stringify({ level: "error", event: "unhandled_error", message }));
  return new HttpException({ code: "INTERNAL_ERROR", message: "erro interno" }, HttpStatus.INTERNAL_SERVER_ERROR);
}
