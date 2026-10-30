import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

// Tracer do provider instalado por initTracing. Sem provider, é o tracer no-op da API.
let tracer = trace.getTracer("wagering-processor");

/**
 * Executa `fn` dentro de um span. Erros viram evento de exceção e status ERROR no span,
 * e são relançados sem alteração (o tratamento continua sendo do chamador).
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Liga o SDK de traces. Sem `OTEL_ENABLED=true` (e sem exportador explícito), a API fica no-op:
 * a instrumentação existe mas não custa nada. Com o flag, os spans vão para o console, que é o
 * exportador da demo. Para OTLP, troque o exportador aqui.
 */
export function initTracing(exporter?: SpanExporter): BasicTracerProvider | undefined {
  if (!exporter && process.env.OTEL_ENABLED !== "true") return undefined;
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter ?? new ConsoleSpanExporter())],
  });
  tracer = provider.getTracer("wagering-processor");
  provider.register();
  return provider;
}
