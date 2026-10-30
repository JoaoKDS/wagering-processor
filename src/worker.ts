import { createOrm } from "./infrastructure/orm";
import { createSqs } from "./messaging/sqs-client";
import { SqsEventBus } from "./messaging/sqs-event-bus";
import { pollOnce } from "./messaging/consumer";
import { OutboxPublisher } from "./outbox/outbox-publisher";
import { SubmitWagerTransaction } from "./wagering/application/submit-wager-transaction";
import { reprocessPendingReferences } from "./wagering/application/pending-reference-worker";
import { log } from "./shared/logger";
import { initTracing } from "./shared/tracing";

initTracing();

/**
 * Processo de background: consumidor SQS, publicação do outbox e worker de referências pendentes.
 * Rode quantas instâncias quiser: a correção vem do banco (lock por wallet, inbox, SKIP LOCKED),
 * não de coordenação entre processos.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não definida`);
  return value;
}

const orm = await createOrm(requireEnv("DATABASE_URL"));
const submit = new SubmitWagerTransaction(orm);
const sqs = createSqs();
const deps = {
  sqs,
  submit,
  queueUrl: requireEnv("SQS_QUEUE_URL"),
  dlqUrl: requireEnv("SQS_DLQ_URL"),
};
const publisher = new OutboxPublisher(orm, new SqsEventBus(sqs, requireEnv("SQS_EVENTS_URL")), 50);

let running = true;
const stop = () => {
  running = false;
  log("info", "stopping");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Outbox: publica eventos pendentes depois do commit. Não sobrepõe execuções no mesmo processo.
let publishing = false;
const outboxTimer = setInterval(async () => {
  if (publishing) return;
  publishing = true;
  try {
    let n = 0;
    do {
      n = await publisher.publishBatch();
    } while (n > 0);
  } catch (err) {
    log("error", "outbox_error", { message: String(err) });
  } finally {
    publishing = false;
  }
}, 1000);

const refTimer = setInterval(() => {
  reprocessPendingReferences(orm, new Date())
    .then((s) => {
      if (s.processed || s.rejected) log("info", "pending_references", { ...s });
    })
    .catch((err) => log("error", "pending_references_error", { message: String(err) }));
}, 5000);

log("info", "worker_started");
while (running) {
  try {
    await pollOnce(deps, 10);
  } catch (err) {
    log("error", "poll_error", { message: String(err) });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

clearInterval(outboxTimer);
clearInterval(refTimer);
sqs.destroy();
await orm.close();
log("info", "worker_stopped");
