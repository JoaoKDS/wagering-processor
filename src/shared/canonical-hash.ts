import { createHash } from "node:crypto";

/**
 * Serialização canônica: chaves ordenadas em todos os níveis e valores undefined removidos.
 * Garante que o mesmo conteúdo de negócio gere sempre o mesmo hash, independentemente da
 * ordem das chaves no JSON recebido.
 *
 * Algoritmo do payloadHash: SHA-256 sobre canonicalJson(subconjunto de campos de negócio).
 * Headers e metadados de transporte NÃO entram no hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child !== undefined) {
        out[key] = sortKeys(child);
      }
    }
    return out;
  }
  return value;
}
