# Arquitetura

## Visão geral

Dois processos, que podem ser replicados à vontade:

- **API** (`src/main.ts`): NestJS, recebe transações por HTTP e expõe consultas.
- **Worker** (`src/worker.ts`): consome a fila SQS e reavalia referências pendentes.

Os dois usam os mesmos casos de uso (`SubmitWagerTransaction`, `CreateWallet`). Não há coordenação entre processos: a correção vem do banco.

## Decisões

### 1. Dinheiro em `bigint` de centavos

`Money` guarda o valor como inteiro de centavos. Não usamos `number` (erro de ponto flutuante) nem uma biblioteca de decimal (dependência extra sem ganho aqui). A entrada é validada estritamente: exatamente 2 casas, sem notação científica, sem negativos. No banco, as colunas são `bigint`.

### 2. ORM: MikroORM, usado para conexão e transação

Usamos `em.transactional()` para abrir a transação e **SQL explícito** dentro dela. Motivo: as regras de lock, idempotência e ledger precisam ficar legíveis e auditáveis, e não escondidas atrás de um mapeamento de entidade.

**Armadilha encontrada na prática:** `tx.getConnection()` e `tx.getKnex()` não ligam as queries à transação. Cada query rodava em autocommit, e o `FOR UPDATE` soltava o lock imediatamente. Os testes de concorrência pegaram o problema. A correção foi usar `getTransactionContext()` por meio de `transactionConn()`, que falha se não houver transação ativa, para nunca escrever fora dela.

### 3. Concorrência: lock pessimista por `walletId`

Cada submissão faz `SELECT ... FOR UPDATE` na linha da carteira. Duas apostas na mesma carteira são serializadas; carteiras diferentes não se bloqueiam. Não há lock global.

Dentro do lock, a ordem é: checar idempotência, aplicar a regra, gravar, emitir eventos. Por isso duas requisições idênticas em paralelo não geram dois débitos.

Como segunda barreira, `updateWallet` filtra por `version` esperada. Com o lock adquirido isso nunca deveria falhar; se falhar, a transação aborta.

**Por que não optimistic locking?** Com contenção alta numa mesma carteira (o caso de apostas), a taxa de retry seria alta. O lock curto por linha é mais previsível.

### 4. Idempotência persistente em duas camadas

- **Submissão:** `idempotency_key` com `UNIQUE` no banco. O `payloadHash` (SHA-256 sobre JSON com chaves ordenadas, só campos de negócio) distingue replay de conflito.
- **Fila:** tabela `inbox_messages` com chave `(consumer_name, message_id)`, gravada **na mesma transação** da aplicação. Se a mensagem já foi processada, o `INSERT` não insere nada e o use case não roda.

Replay devolve o saldo **observado no momento original** (coluna `balance_observed_minor`), e não o saldo atual.

### 5. Ledger append-only

`wallet_ledger_entries` tem um trigger que bloqueia `UPDATE` e `DELETE`. Além disso:

- `UNIQUE (wallet_id, wallet_version)`: duas gravações com a mesma base não coexistem, mesmo se a aplicação falhar em checar.
- `UNIQUE (transaction_id, wallet_id)`: no máximo um lançamento por carteira por transação.
- `CHECK` na aritmética: `balance_after = balance_before ± amount`.

### 6. Outbox transacional

Eventos (`WalletBalanceChanged`, `WagerTransactionProcessed`, etc.) são gravados em `outbox_messages` na mesma transação do saldo e do ledger. Um publisher separado publica depois do commit. O consumidor deduplica pela inbox, então uma publicação duplicada não causa efeito duplicado.

O publisher usa `FOR UPDATE SKIP LOCKED`: vários publishers podem rodar, cada um pegando lotes diferentes.

Modelo de eventos (seção 11 do spec): cada evento é uma subclasse concreta de `IntegrationEvent<T>` (`src/shared/integration-event.ts` e `src/events/integration-events.ts`), com `eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, `causationId` e `occurredAt` em ISO-8601. O `payload` gravado na outbox é o envelope completo, e é exatamente o corpo enviado ao SQS. `OutboxMessage` (`src/outbox/outbox-message.ts`) é a classe de domínio da mensagem da outbox, com `enqueue`, `isDue`, `markPublished` e `scheduleRetry`. `InboxMessage` (`src/messaging/inbox-message.ts`) é a classe de domínio do recebimento, e a inbox é gravada a partir dela.

Limitação conhecida: o publisher aplica o backoff em SQL (`LEAST(power(2, attempts+1), 300)`), para que a decisão de quando publicar aconteça no banco. `OutboxMessage.scheduleRetry` implementa a mesma fórmula, e um teste unitário trava as duas em 2, 4 segundos e no teto de 5 minutos.

### 7. SQS: ack só depois do commit

O consumidor trata três casos:

| Caso | Destino |
|---|---|
| Sucesso ou duplicata | ack (`DeleteMessage`) |
| Erro transitório (5xx, banco indisponível) | sem ack; volta à fila após o timeout de visibilidade |
| Erro permanente (JSON inválido, contrato violado) | envia para a DLQ e faz ack |

REJECTED por regra de negócio **não é erro**: a transação foi registrada como rejeitada, então é ack.

A fila principal manda para a DLQ depois de 5 recebimentos sem ack (`RedrivePolicy`).

**Limitação de FIFO:** se uma mensagem de um grupo falhar de forma transitória, as seguintes do mesmo grupo ficam bloqueadas até ela voltar. Usamos `MessageGroupId = walletId`, então o bloqueio fica restrito à carteira afetada.

### 8. Referências fora de ordem

REFUND e ROLLBACK podem chegar antes da referência. Nesse caso a transação fica `PENDING_REFERENCE` (HTTP 202). O worker reavalia a cada 5 segundos, com `FOR UPDATE SKIP LOCKED` e a mesma carteira travada.

**TTL de 24 horas:** provedores costumam reenviar em minutos. 24 horas cobre atrasos de fila sem deixar transação pendente indefinidamente. Depois disso a transação vira `REJECTED` com `REFERENCE_NOT_FOUND`, e o provedor sabe que deve desistir.

### 9. Taxonomia de falhas

Cada rejeição tem um `failureCode` estável e uma `failureAction` sugerida (`RETRY`, `FIX_PAYLOAD` ou `GIVE_UP`). O catálogo fica em `src/shared/failure-code.ts`.

Separamos `INSUFFICIENT_BALANCE` (aposta sem saldo) de `REVERSAL_WOULD_OVERDRAW` (reversão deixaria saldo negativo). São situações operacionais diferentes: a primeira é normal; a segunda pede análise.

### 10. Migrations e garantias no banco

Todas as garantias de unicidade, imutabilidade e não-negatividade estão no schema, não só no código. Cada migration tem `up` e `down`, e cada uma roda numa transação.

## Testes

| Suíte | Banco | SQS | Objetivo |
|---|---|---|---|
| unit | não | não | regras de domínio puras |
| integration/schema | PostgreSQL real | não | constraints e triggers |
| integration/concurrency | PostgreSQL real | não | lock e saldo sob paralelismo |
| integration/submit | PostgreSQL real | não | regras, idempotência, outbox |
| integration/outbox | PostgreSQL real | não | dois publishers, sem duplicação |
| integration/http | PostgreSQL real | não | endpoints e códigos HTTP |
| integration/pending-reference | PostgreSQL real | não | referência fora de ordem e TTL |
| integration/sqs | PostgreSQL real | LocalStack real | consumidor, inbox, DLQ, dois consumidores |

Invariante verificada nos testes: saldo da carteira igual ao saldo reconstruído pelo ledger.

## Limitações conhecidas

- **Autenticação não implementada.** Desenho: Keycloak ou Zitadel na frente da API; `ProviderIdentityPort` como ponto de extensão.
- **Métricas em memória por processo.** `GET /metrics` (API) e o worker têm registros separados. Em produção, o Prometheus raspa cada instância e agrega. Não há histograma de latência com buckets, só contagem, soma e máximo.
- **Métricas contadas antes do commit.** Uma transação que falha ao commitar ainda é contada. Aceitável para monitoramento operacional, mas não para contabilidade.
- **Entrega de eventos at-least-once.** A fila de eventos é padrão (não FIFO). Consumidores de eventos devem deduplicar pelo `eventId`.
- **Latência do outbox medida pela idade do evento** (`occurred_at` até a publicação), não pelo tempo de fila no SQS.
- **Eventos sem classes `IntegrationEvent`.** O payload é JSON montado nos casos de uso. Tipagem por classe é um ajuste pendente.
- **Reversão parcial fora de escopo**, conforme a spec.
- **Uma moeda (BRL) nos testes.** O modelo é multi-moeda, e os conflitos de moeda são testados no domínio.
- **Teste de carga não implementado.**
