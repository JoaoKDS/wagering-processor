import { createOrm } from "./infrastructure/orm";
import { createSqs } from "./messaging/sqs-client";
import { pollOnce } from "./messaging/consumer";
import { SubmitWagerTransaction } from "./wagering/application/submit-wager-transaction";
import { reprocessPendingReferences } from "./wagering/application/pending-reference-worker";

/**
 * Processo de background: consumidor SQS + worker de referências pendentes.
 * Rode quantas instâncias quiser: a correção vem do banco (lock por wallet, inbox, SKIP LOCKED),
 * não de coordenação entre processos.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não definida`);
  return value;
}

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...data }));
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

let running = true;
const stop = () => {
  running = false;
  log("stopping");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const refTimer = setInterval(() => {
  reprocessPendingReferences(orm, new Date())
    .then((s) => {
      if (s.processed || s.rejected) log("pending_references", { ...s });
    })
    .catch((err) => log("pending_references_error", { message: String(err) }));
}, 5000);

log("worker_started");
while (running) {
  try {
    const stats = await pollOnce(deps, 10);
    if (stats.processed || stats.duplicates || stats.deadLettered || stats.deferred) {
      log("poll", { ...stats });
    }
  } catch (err) {
    log("poll_error", { message: String(err) });
    await Bun.sleep(2000);
  }
}

clearInterval(refTimer);
sqs.destroy();
await orm.close();
log("worker_stopped");
