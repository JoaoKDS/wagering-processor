import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "reflect-metadata";
import { Module, type INestApplication, type Provider } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SQL } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { ORM, PROVIDER_IDENTITY } from "../../src/tokens";
import { JwtProviderIdentity } from "../../src/auth/provider-identity";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { CreateWallet } from "../../src/wallet/application/create-wallet";
import { WalletQueries } from "../../src/wallet/application/wallet-queries";
import { WageringController } from "../../src/http/wagering.controller";
import { WalletsController } from "../../src/http/wallets.controller";
import { runMigrations } from "../../scripts/migrate";

// Autenticação ponta a ponta: API HTTP real + Keycloak real. Health e métricas não entram aqui.
const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering_test";
const base = process.env.KEYCLOAK_BASE_URL ?? "http://localhost:8080";
const issuer = `${base}/realms/wagering`;
const jwksUrl = `${issuer}/protocol/openid-connect/certs`;
const tokenUrl = `${issuer}/protocol/openid-connect/token`;

let sql: SQL;
let orm: MikroORM;
let app: INestApplication;
let api: string;
let token = "";

// Os providers são lidos quando a app é criada, então podem referenciar o ORM preparado no beforeAll.
@Module({
  controllers: [WageringController, WalletsController],
  providers: [
    { provide: ORM, useFactory: () => orm },
    { provide: SubmitWagerTransaction, useFactory: () => new SubmitWagerTransaction(orm) },
    { provide: CreateWallet, useFactory: () => new CreateWallet(orm) },
    { provide: WalletQueries, useFactory: () => new WalletQueries(orm) },
    {
      provide: PROVIDER_IDENTITY,
      useFactory: () => new JwtProviderIdentity({ issuer, audience: "wagering-api", jwksUrl }),
    } as Provider,
  ],
})
class AuthTestModule {}

async function fetchUserToken(): Promise<string> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "wagering-api",
      username: "provider-a",
      password: "provider-a-secret",
    }),
  });
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function waitForToken(): Promise<string> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetchUserToken();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`Keycloak não respondeu em 120s: ${String(lastError)}`);
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const bearer = () => ({ authorization: `Bearer ${token}` });

let walletId = "";
let playerId = "";

beforeAll(async () => {
  sql = new SQL(url);
  await runMigrations(sql, "reset");
  orm = await createOrm(url);
  token = await waitForToken();

  playerId = crypto.randomUUID();
  const created = await new CreateWallet(orm).execute({
    playerId,
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  walletId = created.id;

  app = await NestFactory.create(AuthTestModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  api = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await orm.close();
  await sql.close();
});

function bet(providerId: string, external: string) {
  return {
    providerId,
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: "round-auth",
    gameId: "game-auth",
    kind: "BET",
    money: { amount: "1.00", currency: "BRL" },
  };
}

describe("API com autenticação ponta a ponta (seção 2)", () => {
  test("submissão sem token: 401", async () => {
    const external = `auth-${crypto.randomUUID()}`;
    const res = await call("POST", "/wagering/transactions", bet("provider-a", external), {
      "Idempotency-Key": `provider-a:${external}`,
    });
    expect(res.status).toBe(401);
  });

  test("consulta de wallet sem token: 401", async () => {
    const res = await call("GET", `/wallets/${walletId}`);
    expect(res.status).toBe(401);
  });

  test("provedor do token diferente do corpo: 403 PROVIDER_MISMATCH", async () => {
    const external = `auth-${crypto.randomUUID()}`;
    const res = await call("POST", "/wagering/transactions", bet("provider-b", external), {
      ...bearer(),
      "Idempotency-Key": `provider-b:${external}`,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROVIDER_MISMATCH");
  });

  test("provedor do token diferente da rota: 403 PROVIDER_MISMATCH", async () => {
    const res = await call("GET", `/providers/provider-b/wagering/transactions/x-${crypto.randomUUID()}`, undefined, bearer());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROVIDER_MISMATCH");
  });

  test("token do provedor certo: submissão aceita (200 PROCESSED)", async () => {
    const external = `auth-${crypto.randomUUID()}`;
    const res = await call("POST", "/wagering/transactions", bet("provider-a", external), {
      ...bearer(),
      "Idempotency-Key": `provider-a:${external}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PROCESSED");
  });
});
