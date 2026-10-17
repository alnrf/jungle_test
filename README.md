# Wagering Processor

Serviço de carteira que processa transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de vários provedores, por HTTP ou SQS, e continua correto com mensagem duplicada, fora de ordem e várias instâncias rodando ao mesmo tempo.

Stack: Bun, TypeScript (strict), NestJS, MikroORM, PostgreSQL e SQS (LocalStack).

As decisões de desenho, os trade-offs e o que ficou de fora estão no [ARCHITECTURE.md](./ARCHITECTURE.md). O teste de carga está em [docs/load-test.md](./docs/load-test.md).

## Subindo tudo com Docker

```bash
docker compose up --build
```

Isso sobe:

- `postgres` e `localstack` (SQS, com as filas criadas por `docker/create-queues.sh`)
- `migrate`, que roda as migrations e sai
- `api` com 3 réplicas atrás de um nginx (`gateway`), exposto em `http://localhost:3000`
- `worker` com 3 réplicas (consumer da fila, relay da outbox e worker de referências pendentes)

Para conferir:

```bash
curl localhost:3000/health/ready
```

> Se o LocalStack não criar as filas em ambiente Linux, confira se `docker/create-queues.sh` está executável (`chmod +x docker/create-queues.sh`).

## Rodando local (fora do Docker)

Precisa de Bun 1.x. Postgres e LocalStack podem vir do compose:

```bash
bun install
docker compose up -d postgres localstack
cp .env.example .env
bun run migration:up
bun run start          # APP_ROLE=all: HTTP + workers no mesmo processo
```

Para separar os papéis: `bun run start:api` e `bun run start:worker`.

## Comandos

| comando | o que faz |
|---|---|
| `bun run start` | sobe a aplicação (papel definido por `APP_ROLE`) |
| `bun run migration:up` / `migration:down` | aplica / desfaz a última migration |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | testes de unidade (não precisam de nada rodando) |
| `bun run test:integration` | integração com Postgres e SQS reais |
| `bun run test:concurrency` | concorrência, múltiplos processos e crash |
| `bun run test:all` | os três acima, em sequência |
| `bun run test:load` | teste de carga contra uma instância já rodando |

Os testes de integração e concorrência precisam de `docker compose up -d postgres localstack` e das migrations aplicadas. Os de concorrência sobem processos da própria aplicação (portas 4100+), então não deixe outra instância consumindo a mesma fila enquanto rodam. Para ver os logs desses processos: `TEST_SHOW_LOGS=1`.

## Exemplo rápido

```bash
# cria a wallet
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# aposta (troque o walletId)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Mandar a mesma requisição de novo devolve o mesmo resultado com `"idempotentReplay": true`.

Para mandar pela fila:

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...,"idempotencyKey":"provider-a:transaction-123"}}'
```

## Endpoints

| método | rota | |
|---|---|---|
| POST | `/wallets` | cria wallet (saldo inicial vira lançamento `OPENING`) |
| GET | `/wallets/:walletId` | saldo e versão |
| GET | `/wallets/:walletId/ledger?cursor=&limit=50` | lançamentos, paginação por cursor opaco |
| POST | `/wallets/:walletId/reconciliation` | compara saldo materializado com o ledger |
| POST | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| GET | `/wagering/transactions/:transactionId` | consulta por id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| GET | `/health/live`, `/health/ready` | liveness / readiness (Postgres + SQS) |
| GET | `/metrics` | métricas no formato Prometheus |

Códigos HTTP: `201` processada, `200` replay, `202` aguardando referência, `400` payload inválido, `404` não encontrado, `409` conflito de idempotência ou wallet duplicada, `422` rejeitada por regra de negócio (com `failureCode`), `503` falha transitória (pode reenviar com a mesma chave). Detalhes no ARCHITECTURE.md.

## Variáveis de ambiente

As principais estão em `.env.example`. A lista completa, com os defaults, fica em `src/config/env.ts`.

| variável | default | |
|---|---|---|
| `APP_ROLE` | `all` | `api`, `worker` ou `all` |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | |
| `DB_LOCK_TIMEOUT_MS` | `5000` | `lock_timeout` de cada transação |
| `SQS_ENDPOINT` | — | `http://localhost:4566` com LocalStack |
| `SQS_MAX_ATTEMPTS` | `5` | entregas antes de mandar pra DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `8` | checagens antes de rejeitar por referência ausente |
| `OUTBOX_BATCH_SIZE` | `200` | eventos por lote do relay |

## Estrutura

```
src/
  shared/domain/      Money, erros, ids
  wallet/domain/      Wallet (aggregate), WalletLedgerEntry
  wagering/domain/    WagerTransaction, regras de liquidação, failure codes, payload hash
  messaging/domain/   InboxMessage, OutboxMessage, eventos de integração
  application/        use cases e portas (UnitOfWork, repositórios)
  infra/              MikroORM, SQS, workers, logs e métricas
  interfaces/         HTTP (controllers, filtro de erro, auth) e contratos de entrada
test/
  unit/  integration/  concurrency/  load/
```
