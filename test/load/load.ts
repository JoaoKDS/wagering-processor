// Teste de carga (diferencial, spec seção 14). Não faz parte do `bun test`: é uma medição.
// Uso: bun run test:load
// Variáveis: LOAD_DATABASE_URL, LOAD_WALLETS, LOAD_CONCURRENCY, LOAD_OPS, LOAD_REPORT
//
// Metodologia: submissão direta no caso de uso (sem HTTP e sem fila), para medir o núcleo
// (lock por carteira, idempotência, ledger e outbox). Cada operação é uma BET de 1.00 com chave
// única, distribuída entre as carteiras. A latência é medida de ponta a ponta por submissão.
// Ao final, a outbox é drenada com um bus nulo (mede a vazão de publicação) e o saldo de cada
// carteira é conferido contra o ledger.
import { SQL } from "bun";
import { writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infrastructure/orm";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { CreateWallet } from "../../src/wallet/application/create-wallet";
import { WalletQueries } from "../../src/wallet/application/wallet-queries";
import { OutboxPublisher, type EventBus } from "../../src/outbox/outbox-publisher";
import { metrics } from "../../src/shared/metrics";
import { runMigrations } from "../../scripts/migrate";

const url = process.env.LOAD_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/wagering_load";
const WALLETS = Number(process.env.LOAD_WALLETS ?? 8);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const OPS = Number(process.env.LOAD_OPS ?? 2000);
const REPORT_PATH = process.env.LOAD_REPORT ?? "load-report.json";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return round(sorted[index]!);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const sql = new SQL(url);
await runMigrations(sql, "reset");
const orm: MikroORM = await createOrm(url);
const submit = new SubmitWagerTransaction(orm);
const createWallet = new CreateWallet(orm);
const queries = new WalletQueries(orm);

const wallets: Array<{ walletId: string; playerId: string }> = [];
for (let w = 0; w < WALLETS; w++) {
  const playerId = crypto.randomUUID();
  const created = await createWallet.execute({ playerId, initialBalance: { amount: "10000.00", currency: "BRL" } });
  wallets.push({ walletId: created.id, playerId });
}

const latencies: number[] = [];
const statuses: Record<string, number> = {};
let errors = 0;
let nextOp = 0;

async function worker(): Promise<void> {
  while (true) {
    const i = nextOp++;
    if (i >= OPS) return;
    const target = wallets[i % WALLETS]!;
    const external = `load-${i}-${crypto.randomUUID()}`;
    const t0 = performance.now();
    try {
      const result = await submit.execute({
        idempotencyKey: `provider-a:${external}`,
        providerId: "provider-a",
        externalTransactionId: external,
        playerId: target.playerId,
        walletId: target.walletId,
        roundId: "round-load",
        gameId: "game-load",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      });
      statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const elapsedS = (performance.now() - startedAt) / 1000;

// Lag da outbox logo após a carga, antes de qualquer publicação
const lagBeforeDrain = await queries.outboxLagSeconds();

// Vazão de publicação: drena a outbox com um bus nulo
const nullBus: EventBus = { publish: async () => {} };
const publisher = new OutboxPublisher(orm, nullBus, 200);
let drained = 0;
const drainStart = performance.now();
let batch: number;
do {
  batch = await publisher.publishBatch();
  drained += batch;
} while (batch > 0);
const drainS = (performance.now() - drainStart) / 1000;

// Invariante: saldo == soma do ledger, em todas as carteiras
let invariantsOk = true;
for (const w of wallets) {
  const [wallet] = await sql`SELECT balance_minor FROM wallets WHERE id = ${w.walletId}`;
  const [ledger] = await sql`
    SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::text AS calc
      FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId}`;
  if (BigInt(wallet.balance_minor) !== BigInt(ledger.calc)) invariantsOk = false;
}

const sorted = [...latencies].sort((a, b) => a - b);
const report = {
  environment: {
    platform: platform(),
    release: release(),
    cpus: cpus().length,
    bun: Bun.version,
    database: "PostgreSQL em container (docker compose)",
  },
  methodology:
    "Submissão direta no caso de uso (sem HTTP e sem fila). BET de 1.00 com chave única, distribuída entre as carteiras. Latência medida por submissão. Depois, a outbox é drenada com bus nulo e o saldo é conferido contra o ledger.",
  config: { wallets: WALLETS, concurrency: CONCURRENCY, operations: OPS },
  throughputPerSec: round(OPS / elapsedS),
  elapsedSeconds: round(elapsedS),
  latencyMs: {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: round(sorted[sorted.length - 1] ?? 0),
  },
  statuses,
  errors,
  errorRate: round(errors / OPS),
  walletLockContended: metrics.get("wallet_lock_contended_total"),
  outbox: {
    lagSecondsBeforeDrain: round(lagBeforeDrain),
    drainedEvents: drained,
    drainThroughputPerSec: round(drained / drainS),
  },
  invariantsOk,
};

console.log(JSON.stringify(report, null, 2));
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

await orm.close();
await sql.close();
if (!invariantsOk || errors > 0) process.exit(1);
