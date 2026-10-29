/**
 * Log estruturado (uma linha JSON por evento).
 * Regra: nunca logar payloads financeiros completos nem dados sensíveis.
 * Passe só identificadores: messageId, transactionId, walletId, providerId, correlationId, outcome.
 */
export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
