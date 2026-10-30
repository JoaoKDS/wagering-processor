import "reflect-metadata";
import { Module, type Provider } from "@nestjs/common";
import { createOrm } from "./infrastructure/orm";
import { ORM, PROVIDER_IDENTITY, SQS_PROBE } from "./tokens";
import { JwtProviderIdentity, NoopProviderIdentity, type ProviderIdentityPort } from "./auth/provider-identity";
import { createSqs } from "./messaging/sqs-client";
import { makeSqsProbe } from "./messaging/sqs-probe";
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

/** AUTH_MODE=jwt liga a validação de token do Keycloak; qualquer outro valor fica no modo de desenvolvimento. */
function identityFromEnv(): ProviderIdentityPort {
  if (process.env.AUTH_MODE !== "jwt") return new NoopProviderIdentity();
  const issuer = process.env.KEYCLOAK_ISSUER;
  const jwksUrl = process.env.KEYCLOAK_JWKS_URL;
  if (!issuer || !jwksUrl) throw new Error("AUTH_MODE=jwt exige KEYCLOAK_ISSUER e KEYCLOAK_JWKS_URL");
  return new JwtProviderIdentity({
    issuer,
    jwksUrl,
    audience: process.env.KEYCLOAK_AUDIENCE ?? "wagering-api",
  });
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
  { provide: PROVIDER_IDENTITY, useValue: identityFromEnv() },
  { provide: SQS_PROBE, useFactory: () => makeSqsProbe(createSqs(), process.env.SQS_QUEUE_URL) },
];

@Module({
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers,
})
export class AppModule {}
