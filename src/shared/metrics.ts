type Labels = Record<string, string>;

interface Summary {
  count: number;
  sum: number;
  max: number;
}

function keyOf(name: string, labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([k, v]) => `${k}="${v}"`).join(",")}}`;
}

/**
 * Métricas em memória, no formato texto do Prometheus.
 * Escopo: cada processo (API ou worker) tem o seu registro. Em produção, cada instância
 * é raspada separadamente e o Prometheus agrega.
 */
export class Metrics {
  private counters = new Map<string, number>();
  private summaries = new Map<string, Summary>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const key = keyOf(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** Registra uma observação (ex.: latência em ms): guarda contagem, soma e máximo. */
  observe(name: string, value: number, labels: Labels = {}): void {
    const key = keyOf(name, labels);
    const s = this.summaries.get(key) ?? { count: 0, sum: 0, max: 0 };
    s.count += 1;
    s.sum += value;
    s.max = Math.max(s.max, value);
    this.summaries.set(key, s);
  }

  get(name: string, labels: Labels = {}): number {
    return this.counters.get(keyOf(name, labels)) ?? 0;
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.counters.entries()].sort()) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, s] of [...this.summaries.entries()].sort()) {
      // "nome{labels}" -> "nome_count{labels}", "nome_sum{labels}", "nome_max{labels}"
      const i = key.indexOf("{");
      const name = i < 0 ? key : key.slice(0, i);
      const labels = i < 0 ? "" : key.slice(i);
      lines.push(`${name}_count${labels} ${s.count}`);
      lines.push(`${name}_sum${labels} ${s.sum}`);
      lines.push(`${name}_max${labels} ${s.max}`);
    }
    return lines.join("\n") + "\n";
  }
}

/** Registro único do processo. */
export const metrics = new Metrics();
