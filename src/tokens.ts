/** Token de injeção do MikroORM (conexão e transações). */
export const ORM = Symbol("ORM");

/** Porta de identidade do provedor (seção 2 da spec). Implementação padrão: no-op. */
export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

/** Sonda de disponibilidade do SQS, usada no /health/ready. */
export const SQS_PROBE = Symbol("SQS_PROBE");
