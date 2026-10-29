import { Controller, Get, Header, Inject } from "@nestjs/common";
import { metrics } from "../shared/metrics";
import { WalletQueries } from "../wallet/application/wallet-queries";

/** Endpoint de métricas no formato texto do Prometheus. Sem autenticação, como os health checks. */
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(WalletQueries) private readonly queries: WalletQueries) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  async scrape(): Promise<string> {
    const lag = await this.queries.outboxLagSeconds().catch(() => -1);
    return metrics.toPrometheus() + `outbox_lag_seconds ${lag}\n`;
  }
}
