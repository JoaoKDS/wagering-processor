import { Controller, Get, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { WalletQueries } from "../wallet/application/wallet-queries";
import { SQS_PROBE } from "../tokens";

/** Endpoints abertos: não exigem autenticação (spec, seção 9). */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(SQS_PROBE) private readonly sqsProbe: () => Promise<boolean>,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Pronto só se PostgreSQL e SQS respondem (spec, seção 9). */
  @Get("ready")
  async ready() {
    const [db, sqs] = await Promise.all([this.queries.ping(), this.sqsProbe()]);
    if (!db || !sqs) {
      throw new HttpException({ status: "unavailable", db, sqs }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: "ok", db: true, sqs: true };
  }
}
