import "reflect-metadata";
import { Module, type Provider } from "@nestjs/common";
import { createOrm } from "./infrastructure/orm";
import { ORM } from "./tokens";
import { SubmitWagerTransaction } from "./wagering/application/submit-wager-transaction";
import { CreateWallet } from "./wallet/application/create-wallet";
import { WalletQueries } from "./wallet/application/wallet-queries";
import { WalletsController } from "./http/wallets.controller";
import { WageringController } from "./http/wagering.controller";
import { HealthController } from "./http/health.controller";
import { MetricsController } from "./http/metrics.controller";
import type { MikroORM } from "@mikro-orm/postgresql";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definida");
  return url;
}

/**
 * Composição explícita: os casos de uso recebem o ORM por fábrica, sem decorators nas classes
 * de domínio. Assim o núcleo continua testável sem NestJS.
 */
const providers: Provider[] = [
  { provide: ORM, useFactory: () => createOrm(databaseUrl()) },
  { provide: SubmitWagerTransaction, useFactory: (orm: MikroORM) => new SubmitWagerTransaction(orm), inject: [ORM] },
  { provide: CreateWallet, useFactory: (orm: MikroORM) => new CreateWallet(orm), inject: [ORM] },
  { provide: WalletQueries, useFactory: (orm: MikroORM) => new WalletQueries(orm), inject: [ORM] },
];

@Module({
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers,
})
export class AppModule {}
