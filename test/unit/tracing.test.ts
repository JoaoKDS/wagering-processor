import { beforeAll, describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { initTracing, withSpan } from "../../src/shared/tracing";

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;

beforeAll(() => {
  provider = initTracing(exporter);
});

/** Força a exportação dos spans já encerrados antes de ler o exportador em memória. */
async function flush(): Promise<void> {
  await provider?.forceFlush();
}

describe("withSpan (OpenTelemetry)", () => {
  test("cria span com nome e atributos, com status OK, e devolve o resultado", async () => {
    exporter.reset();
    const result = await withSpan("wager.test", { "wager.wallet_id": "w-1" }, async () => 42);
    await flush();

    expect(result).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span).toBeDefined();
    expect(span!.name).toBe("wager.test");
    expect(span!.attributes["wager.wallet_id"]).toBe("w-1");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  test("erro: span vai para ERROR, registra a exceção e relança sem alterar o erro", async () => {
    exporter.reset();
    await expect(
      withSpan("wager.fail", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await flush();

    const [span] = exporter.getFinishedSpans();
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.events.some((e) => e.name === "exception")).toBe(true);
  });
});
