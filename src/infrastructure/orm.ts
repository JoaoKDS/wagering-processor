import { MikroORM } from "@mikro-orm/postgresql";

/**
 * MikroORM como gerenciador de conexão e transações (em.transactional).
 * Não há entidades mapeadas: as regras de ledger, lock e idempotência usam SQL explícito
 * (ver ledger-store.ts), porque é aí que a correção financeira precisa ser auditável.
 */
export function createOrm(clientUrl: string): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
}
