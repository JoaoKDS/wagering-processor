# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas de múltiplos provedores. Stack: Bun, TypeScript estrito, NestJS, PostgreSQL, SQS via LocalStack, MikroORM, Docker Compose.

Decisões de arquitetura estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- Bun 1.x
- Docker (Docker Desktop no Windows)

## Setup

```bash
bun install
docker compose up -d
```

O compose sobe PostgreSQL na porta **5433** e LocalStack (SQS) na porta **4566**.

## Variáveis de ambiente

| Variável | Uso | Exemplo |
|---|---|---|
| `DATABASE_URL` | banco da aplicação | `postgres://postgres:postgres@localhost:5433/wagering` |
| `TEST_DATABASE_URL` | banco dos testes (recriado a cada execução) | `postgres://postgres:postgres@localhost:5433/wagering_test` |
| `SQS_ENDPOINT` | endpoint do SQS (LocalStack) | `http://localhost:4566` |
| `SQS_QUEUE_URL` / `SQS_DLQ_URL` / `SQS_EVENTS_URL` | URLs das filas (saída de `queues:create`) | |
| `PORT` | porta da API (padrão 3000) | `3000` |

## Comandos

```bash
bun run migrate            # aplica migrations
bun run migrate:down       # reverte a última
bun run queues:create      # cria fila principal e DLQ no LocalStack
bun run start              # API HTTP
bun run worker             # consumidor SQS + worker de referências pendentes
bun run typecheck          # tsc --noEmit (strict)
bun run test:unit          # domínio puro, sem banco
bun run test:integration   # PostgreSQL e SQS reais
```

Antes de rodar os testes de integração, crie o banco de testes uma vez:

```bash
docker compose exec postgres psql -U postgres -c "CREATE DATABASE wagering_test"
```

## Endpoints principais

| Método | Caminho | Descrição |
|---|---|---|
| POST | `/wallets` | cria wallet (com saldo inicial gera OPENING) |
| GET | `/wallets/:id` | saldo e versão |
| GET | `/wallets/:id/ledger?cursor=&limit=` | lançamentos, paginação por cursor opaco |
| POST | `/wallets/:id/reconciliation` | recalcula o saldo pelo ledger e compara |
| POST | `/wagering/transactions` | submete transação (exige `Idempotency-Key`) |
| GET | `/wagering/transactions/:id` | consulta por id interno |
| GET | `/providers/:p/wagering/transactions/:ext` | consulta por id do provedor |
| GET | `/metrics` | métricas no formato Prometheus (sem autenticação) |
| GET | `/health/live` | processo vivo (sem autenticação) |
| GET | `/health/ready` | PostgreSQL e SQS alcançáveis (503 se qualquer um falhar) |

### Códigos de resposta de `POST /wagering/transactions`

| Status | Situação | Ação do provedor |
|---|---|---|
| 200 | PROCESSED (inclui replay idempotente) | nenhuma |
| 202 | PENDING_REFERENCE, aguardando a referência | aguardar |
| 422 | REJECTED por regra de negócio (`failureCode`, `failureAction`) | depende do `failureAction` |
| 400 | payload inválido | corrigir e reenviar |
| 404 | wallet inexistente | verificar o id |
| 409 | mesma `Idempotency-Key` com payload diferente | não reenviar; investigar |
| 503 | falha transitória | reenviar |

## Eventos publicados

Gravados na outbox na mesma transação da alteração e publicados no SQS depois do commit. Todos seguem o envelope `IntegrationEvent` (`eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `data`).

| Evento | Quando |
|---|---|
| `WalletBalanceChanged` | só quando o saldo muda (inclui OPENING) |
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS |
| `WagerTransactionRejected` | rejeição por regra de negócio, inclusive referência esgotada |
| `WagerTransactionPendingReference` | referência ausente; transação aguarda |

## Testes

| Comando | O que prova |
|---|---|
| `bun run test:unit` | regras de domínio: Money, Wallet, transações, envelope, outbox, inbox |
| `bun run test:integration` | PostgreSQL e LocalStack reais: constraints, concorrência, idempotência, outbox, SQS, DLQ, HTTP |
| `bun run test:load` | teste de carga (diferencial): vazão, p50/p95/p99, erros, conflitos de lock, lag da outbox. Gera `load-report.json` |

Para o teste de carga, crie antes o banco `wagering_load` (`docker compose exec postgres psql -U postgres -c "CREATE DATABASE wagering_load"`). Variáveis opcionais: `LOAD_DATABASE_URL`, `LOAD_WALLETS` (8), `LOAD_CONCURRENCY` (20), `LOAD_OPS` (2000), `LOAD_REPORT`.

Cenários de concorrência e recuperação que estão nos testes de integração:

- **Mesma aposta 50 vezes em paralelo:** um único débito.
- **Duas apostas de 80 com saldo de 100:** exatamente uma `PROCESSED`, e saldo final de 20.
- **Três processos reais** na mesma carteira, com chaves sobrepostas (`multiprocess.test.ts`).
- **Worker morto depois do commit e antes do ack** (`crash-recovery.test.ts`).
- **Publicador morto antes de publicar** (`outbox-recovery.test.ts`).
- **Reinício com SIGKILL** e reenvio das mesmas chaves, sem débito duplicado (`multiprocess.test.ts`).
- **Invariante final em todos os testes:** saldo da carteira igual ao saldo reconstruído pelo ledger.

## Autenticação

Não implementada, conforme a seção 2 da spec. O desenho com Keycloak ou Zitadel está em `ARCHITECTURE.md`. O ponto de extensão é o `ProviderIdentityPort` (`src/auth/provider-identity.ts`), aplicado pelo `ProviderAuthGuard` em `POST /wagering/transactions`, nas consultas de transação e nas rotas de wallets. Health e métricas ficam abertos.
