// Processo filho usado pelos testes multi-processo e de reinício.
// Parâmetros por variável de ambiente (não por argv, que muda entre "bun run" e execução direta):
//   WM_DB_URL, WM_WALLET_ID, WM_PLAYER_ID, WM_PREFIX, WM_COUNT, WM_AMOUNT
// Submete WM_COUNT apostas com idempotency keys "<WM_PREFIX>-<i>" e sai com código 0 ao terminar.
import { createOrm } from "../../../src/infrastructure/orm";
import { SubmitWagerTransaction } from "../../../src/wagering/application/submit-wager-transaction";

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`variável ${name} não definida`);
    process.exit(2);
  }
  return value;
}

const databaseUrl = env("WM_DB_URL");
const walletId = env("WM_WALLET_ID");
const playerId = env("WM_PLAYER_ID");
const prefix = env("WM_PREFIX");
const count = Number(env("WM_COUNT"));
const amount = env("WM_AMOUNT");

const orm = await createOrm(databaseUrl);
const submit = new SubmitWagerTransaction(orm);

for (let i = 0; i < count; i++) {
  const external = `${prefix}-${i}`;
  await submit.execute({
    idempotencyKey: `provider-a:${external}`,
    providerId: "provider-a",
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: "round-mp",
    gameId: "game-mp",
    kind: "BET",
    money: { amount, currency: "BRL" },
  });
}

await orm.close();
process.exit(0);
