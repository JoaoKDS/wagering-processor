import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import { ProviderAuthGuard } from "../auth/provider-identity";
import { log } from "../shared/logger";
import { FAILURE_CATALOG, type FailureCode } from "../shared/failure-code";
import {
  SubmitWagerTransaction,
  type SubmitInput,
  type SubmitResult,
} from "../wagering/application/submit-wager-transaction";
import { WalletQueries } from "../wallet/application/wallet-queries";
import { toHttpException } from "./errors";

/** Só o que o controller usa da resposta HTTP. Evita depender de tipos do Express. */
interface ResponseLike {
  status(code: number): void;
}

/**
 * Status por resultado de submissão:
 * 200 PROCESSED (inclui replay idempotente)
 * 202 PENDING_REFERENCE (aceito, aguardando a referência)
 * 422 REJECTED (regra de negócio; corpo traz failureCode)
 */
function statusFor(result: SubmitResult): number {
  switch (result.status) {
    case "PROCESSED": return HttpStatus.OK;
    case "PENDING_REFERENCE": return HttpStatus.ACCEPTED;
    case "REJECTED": return HttpStatus.UNPROCESSABLE_ENTITY;
    default: return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: ResponseLike,
  ) {
    if (!idempotencyKey) {
      throw new HttpException(
        { code: "INVALID_PAYLOAD", message: "header Idempotency-Key é obrigatório" },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const input = { ...(body as object), idempotencyKey } as SubmitInput;
      const result = await this.submit.execute(input);
      res.status(statusFor(result));
      log("info", "http_submission", {
        correlationId: idempotencyKey,
        transactionId: result.transactionId,
        providerId: (body as { providerId?: unknown }).providerId,
        walletId: (body as { walletId?: unknown }).walletId,
        outcome: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance,
        idempotentReplay: result.idempotentReplay,
        ...(result.failureCode ? { failureCode: result.failureCode, failureAction: failureActionOf(result.failureCode) } : {}),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId") transactionId: string) {
    const tx = await this.queries.transactionById(transactionId);
    if (!tx) throw new HttpException({ code: "TRANSACTION_NOT_FOUND" }, HttpStatus.NOT_FOUND);
    return tx;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const tx = await this.queries.transactionByExternalId(providerId, externalTransactionId);
    if (!tx) throw new HttpException({ code: "TRANSACTION_NOT_FOUND" }, HttpStatus.NOT_FOUND);
    return tx;
  }
}

function failureActionOf(code: FailureCode): string {
  return FAILURE_CATALOG[code].action;
}
