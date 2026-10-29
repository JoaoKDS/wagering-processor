import type { FailureCode } from "./failure-code";

/**
 * Erro de regra de negócio. Carrega um failureCode estável, legível por máquina,
 * que vai para a resposta da API e para o registro auditável da transação.
 */
export abstract class DomainError extends Error {
  abstract readonly failureCode: FailureCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
