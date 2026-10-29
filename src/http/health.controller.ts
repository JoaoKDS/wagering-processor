import { Controller, Get, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { WalletQueries } from "../wallet/application/wallet-queries";

/** Endpoints abertos: não exigem autenticação (spec, seção 9). */
@Controller("health")
export class HealthController {
  constructor(@Inject(WalletQueries) private readonly queries: WalletQueries) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const ok = await this.queries.ping();
    if (!ok) throw new HttpException({ status: "unavailable", db: false }, HttpStatus.SERVICE_UNAVAILABLE);
    return { status: "ok", db: true };
  }
}
