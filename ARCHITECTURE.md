# Arquitetura e decisões

Este documento explica como o serviço garante as invariantes do desafio e por que escolhi cada caminho. Onde houve interpretação de regra, está marcado como **interpretação**.

## Visão geral

```
           HTTP                                  SQS (wager-transactions.fifo)
             |                                              |
   WageringController                              WagerQueueConsumer
             \                                            /
              +------> SubmitWagerTransaction <----------+
                              |
                    UnitOfWork.run (1 transação SQL)
                              |
         inbox -> lock wallet -> transação -> ledger -> saldo -> outbox
                              |
                           COMMIT
                              |
          OutboxRelay (FOR UPDATE SKIP LOCKED) ---> wagering-events.fifo
          PendingReferenceWorker (referências que ainda não chegaram)
```

Os papéis são separados por `APP_ROLE`. No compose ficam 3 réplicas de `api` e 3 de `worker`, todas sem estado local. Qualquer coisa que precise ser garantida fica no Postgres.

## Camadas

- **Domínio** (`*/domain`): `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage` e os eventos. Construtores privados com factories (`create`/`open`/`enqueue` validam, `rehydrate` só reconstrói). Não importa nada de Nest nem de ORM.
- **Regra de liquidação** (`wagering/domain/wager-settlement.ts`): função pura que recebe transação, wallet e referência e decide. É onde estão as regras de BET/WIN/LOSS/REFUND/ROLLBACK, e é por isso que dá para testar todas sem banco.
- **Aplicação** (`application/`): use cases e as portas (`UnitOfWork` e repositórios). O `WagerSettler` junta a regra pura com persistência e outbox, e é usado tanto pela submissão quanto pelo worker de referências.
- **Infra** (`infra/`): MikroORM, SQS, workers, logs e métricas.
- **Interfaces** (`interfaces/`): controllers HTTP, filtro de erro, guard de auth e os contratos (zod) compartilhados entre HTTP e fila.

HTTP e SQS chamam exatamente o mesmo `SubmitWagerTransaction`. A única diferença é que a fila passa `messageId` e o use case grava a inbox na mesma transação.

## ORM e persistência

Usei **MikroORM**. Os motivos: `em.transactional()` deixa explícito onde a transação começa e termina, `LockMode` cobre `FOR UPDATE` e `FOR UPDATE SKIP LOCKED` sem SQL na mão, e o Migrator aceita migrations escritas à mão com `up`/`down`.

Uma decisão que vale explicar: **no caminho financeiro eu não uso o Identity Map nem o flush do Unit of Work**. As leituras usam QueryBuilder com `execute(..., mapResults)` e voltam como objeto simples. As escritas são `insert`/`nativeUpdate` explícitos. Com entidades gerenciadas, a ordem dos statements e o `where version = ?` ficam implícitos no flush, e reler uma linha depois de um `nativeUpdate` devolveria o valor em cache. Aqui eu quero ver exatamente qual SQL roda e em que ordem. O preço é escrever o mapeamento linha ↔ domínio à mão (`infra/database/repositories.ts`), que é pouco código.

As tabelas são mapeadas com `EntitySchema` sobre interfaces simples (`schemas.ts`). Assim o domínio não tem decorator nenhum.

Cada `UnitOfWork.run` faz `orm.em.fork().transactional(...)`, seta `lock_timeout` (5s por padrão) e retenta a transação inteira em deadlock, falha de serialização, lock timeout e conflito de versão. São até 4 tentativas com backoff curto e jitter. Esgotou, vira `TransientInfrastructureError` (503 na API, retry com backoff na fila).

### Money

- No contrato: `{ "amount": "25.00", "currency": "BRL" }`, sempre string. `number` é recusado na validação.
- Na memória: centavos em `bigint`. Como a escala é fixa em 2 e não existe multiplicação nem divisão no domínio (sem juros, sem câmbio, sem rateio), `bigint` resolve sem biblioteca de decimal e sem nenhum arredondamento.
- No banco: `numeric(20,2)` mais `char(3)` em colunas separadas. O driver devolve `numeric` como string, que vai direto para `Money.fromPersistence`.
- Entrada inválida é rejeitada: `NaN`, `Infinity`, notação científica, vazio, mais de 2 casas, sinal, zero à esquerda e negativos. Aceito `"25"` e `"25.5"` e normalizo para `"25.00"`/`"25.50"` (**interpretação**: o requisito fala em serializar com 2 casas; ser tolerante na entrada não abre brecha porque o valor é exato).
- O modelo é multi-moeda (wallet por player + moeda, operações entre moedas lançam erro), mas tudo foi testado com BRL, como o desafio permite.

## Concorrência

A unidade de concorrência é a wallet. A estratégia é **lock pessimista por wallet** mais **update condicionado por versão**, com as invariantes também no schema:

1. Todo caminho que escreve começa com `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`. Duas operações na mesma wallet ficam em fila. Wallets diferentes não se bloqueiam.
2. O saldo é gravado com `UPDATE wallets SET balance = ?, version = ? WHERE id = ? AND version = ?`. Com o lock isso nunca falha. Está ali como segunda barreira caso alguém escreva um caminho novo esquecendo o lock (e aí vira retry, não lost update).
3. `CHECK (balance >= 0)` e os triggers do ledger (abaixo) garantem que, mesmo com bug no código, o banco não aceita saldo negativo nem saldo sem lançamento.

**Por que pessimista e não otimista puro:** o cenário típico de cassino é a hot wallet (um jogador fazendo muitas apostas por segundo). Com lock otimista, cada colisão vira retry da transação inteira, e sob carga isso degenera em muitos retries e latência imprevisível. Com `FOR UPDATE`, as operações da mesma wallet esperam na fila do Postgres, que é FIFO e barato. O custo é que a vazão de uma wallet fica limitada pela latência de uma transação. Para uma única wallet isso está longe de ser problema (ver teste de carga).

**Deadlock:** cada transação trava no máximo uma wallet, e a ordem é sempre inbox, depois wallet, depois linhas de `wager_transactions` daquela wallet. Toda alteração em `wager_transactions` acontece segurando o lock da wallet dela, então não precisa de lock separado na transação.

**Não tem lock global** e nada depende de estado em memória, então N instâncias se comportam como uma. O teste `multi-instance` sobe 3 processos e manda carga misturando HTTP nas três instâncias e mensagens na fila para a mesma wallet.

A ordenação da FIFO (`MessageGroupId` = walletId) ajuda a manter a ordem de chegada, mas não é a garantia. A garantia é o lock no banco.

## Idempotência

São três camadas, todas persistentes:

| camada | onde | protege contra |
|---|---|---|
| inbox `(consumer_name, message_id)` | PK em `inbox_messages` | redelivery da mesma mensagem SQS |
| `(provider_id, idempotency_key)` | UNIQUE | a mesma operação por qualquer canal |
| `(provider_id, external_transaction_id)` | UNIQUE | o mesmo id do provedor com outra chave |

Fluxo da submissão, numa transação só:

1. Se veio da fila, insere na inbox com `ON CONFLICT DO NOTHING`. Se já existia, é redelivery e devolve o resultado original.
2. Procura a transação pela chave. Se existe e o `payloadHash` bate, é replay. Se não bate, é **conflito** (409 / DLQ), nunca replay.
3. Trava a wallet e procura de novo. Isso cobre a corrida em que duas requisições iguais passaram pelo passo 2 ao mesmo tempo: a segunda espera o lock e encontra a primeira já gravada.
4. Se mesmo assim duas transações conseguirem inserir a mesma chave (só acontece quando o payload diverge no `walletId`, porque aí os locks são de wallets diferentes), a UNIQUE estoura, o `UnitOfWork` roda a transação de novo e ela cai no passo 2 como conflito.

O replay devolve o **resultado original**, incluindo o saldo daquele momento. Ele fica gravado em `wager_transactions.observed_balance` no momento da decisão.

**Payload hash:** sha256 em hex do JSON canônico dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (amount já normalizado) e `referenceExternalTransactionId`. Canônico aqui significa chaves ordenadas recursivamente, sem espaços e sem campos `undefined`. Header e metadados de transporte (messageId, occurredAt) ficam de fora. Tem um teste com vetor fixo que dá para conferir com `printf '<json>' | sha256sum`.

## Regras de negócio e interpretações

| operação | saldo | ledger | referência |
|---|---|---|---|
| BET | débito | DEBIT | não aceita |
| WIN | crédito | CREDIT | opcional, só BET da mesma rodada |
| LOSS | nada | nenhum | opcional, só BET da mesma rodada |
| REFUND | crédito | CREDIT | obrigatória, só BET |
| ROLLBACK | inverso da referência | invertido | obrigatória, BET, WIN ou REFUND |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`). Reversão precisa ter o mesmo valor da referência (`REVERSAL_AMOUNT_MISMATCH`) e a referência precisa estar `PROCESSED` (`REFERENCE_NOT_PROCESSED`).

Interpretações:

- **Uma reversão por referência, somando REFUND e ROLLBACK.** O enunciado diz "não pode ser revertida duas vezes pelo mesmo tipo de operação". Se eu permitisse um REFUND e depois um ROLLBACK do mesmo BET, o jogador receberia o valor de volta duas vezes. Então qualquer reversão processada bloqueia outra, e isso está no schema (`uq_wager_tx_single_reversal`). Um ROLLBACK *do REFUND* continua permitido, porque referencia outra transação.
- **WIN e LOSS podem referenciar o BET.** Se referenciarem, valido igual às reversões, exceto valor (o prêmio é diferente da aposta). Se a referência ainda não chegou, esperam como as reversões.
- **Wallet inexistente** não gera transação persistida, porque não tem wallet para pendurar a FK. Na API é 404 `WALLET_NOT_FOUND`. Na fila vai para a DLQ, que é onde alguém vai olhar.
- **Rejeição é resultado, não erro.** Saldo insuficiente, moeda errada e referência inválida ficam gravados como `REJECTED` com `failureCode`, geram evento `WagerTransactionRejected` e respondem 422. O replay devolve a mesma rejeição.
- **Reversão que deixaria saldo negativo** (ex.: ROLLBACK de um WIN que o jogador já apostou) é `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS`, código diferente de `INSUFFICIENT_FUNDS`. Uma aposta sem saldo é rotina. Um estorno sem saldo é algo que alguém precisa olhar.
- **OPENING** é interno: o provider `internal` é reservado, e o schema exige `kind = 'OPENING'` se e somente se `provider_id = 'internal'`. A abertura com saldo zero não gera transação nem lançamento.
- **`FAILED`** só é usado quando o worker de referências encontra um erro inesperado (não transitório) ao reprocessar uma transação. Ela sai do ciclo de retry e fica auditável com `PROCESSING_ERROR`. Na submissão síncrona, erro de infraestrutura desfaz a transação inteira e o cliente reenvia, então não tem o que marcar como `FAILED`.

### Estados da transação

```
PENDING -> PROCESSED | REJECTED | PENDING_REFERENCE
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (reagendada)
```

`PENDING` só existe em memória: a decisão sai na mesma transação SQL em que a linha é inserida. Os estados terminais lançam `InvalidTransactionStateError` se alguém tentar mudá-los (é bug, não regra de negócio), e o banco também bloqueia por trigger.

### Referências fora de ordem

Quando a referência não existe, a transação é gravada como `PENDING_REFERENCE` (HTTP 202) e gera `WagerTransactionPendingReference`. Ela sai desse estado de dois jeitos:

1. **A referência chega.** Na mesma transação SQL em que a referência é decidida, procuro quem estava esperando por ela naquela wallet e decido na hora. Isso cobre o caso comum sem depender do worker. Se a referência for rejeitada, os dependentes também são (`REFERENCE_NOT_PROCESSED`).
2. **Worker agendado.** Cada instância de worker varre as `PENDING_REFERENCE` vencidas. Para cada uma: trava a wallet, relê o status e reavalia. Várias instâncias podem pegar o mesmo candidato. Quem chega depois encontra a transação decidida ou reagendada e pula.

Política: backoff exponencial começando em 2s e dobrando até 5min, com 8 tentativas, o que dá uns 4 minutos no total. A ideia é que um provedor que manda o ROLLBACK antes do BET normalmente manda o BET segundos depois. Se passaram minutos, o mais provável é que o BET nunca vá chegar, e segurar a transação por mais tempo só atrasa a resposta para o provedor. Esgotou: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`. Tudo é configurável por variável de ambiente.

### Códigos de falha

| código | quando | o provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | não reenviar igual |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria saldo negativo | investigar/conciliar com a operação |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir o payload |
| `WALLET_NOT_FOUND` | wallet não existe | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | player não é o dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do prazo | enviar a referência e a reversão de novo com outro id |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/rodada/moeda | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: REFUND de um WIN | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada | desistir |
| `REFERENCE_ALREADY_REVERSED` | já existe reversão processada | desistir (já foi feito) |
| `REVERSAL_AMOUNT_MISMATCH` | valor diferente da referência | corrigir o payload |
| `PROCESSING_ERROR` | erro inesperado no reprocessamento (`FAILED`) | contatar a operação |

## Mapeamento HTTP

O mesmo em todos os endpoints (`interfaces/http/error-filter.ts`):

| status | significado | pode reenviar igual? |
|---|---|---|
| 201 | processada agora | — |
| 200 | replay (já tinha sido processada) | — |
| 202 | aceita, aguardando referência | sim, é idempotente |
| 400 | payload inválido (`VALIDATION_ERROR`, `INVALID_MONEY`...) | não, corrigir antes |
| 404 | wallet ou transação não existe | não |
| 409 | `IDEMPOTENCY_CONFLICT` ou `WALLET_ALREADY_EXISTS` | não |
| 422 | rejeitada por regra de negócio, com `failureCode` | não |
| 503 | falha transitória (banco fora, contenção que esgotou retry), com `Retry-After` | sim, com a mesma `Idempotency-Key` |
| 500 | erro inesperado, ou transação `FAILED` | não automaticamente |

Corpo de erro: `{ "error": { "code", "message", "details?" }, "correlationId" }`. Respostas de transação (201/200/202/422) usam o formato do enunciado, com `failureCode` quando rejeitada.

## SQS

`wager-transactions.fifo` com DLQ `wager-transactions-dlq.fifo`.

- O consumer pega até 10 mensagens por vez. Mensagens do mesmo `MessageGroupId` são processadas em sequência e grupos diferentes em paralelo.
- **Ack (DeleteMessage) só depois do commit.** Se o processo morrer entre o commit e o ack, a mensagem volta depois do visibility timeout e a inbox detecta a duplicata. Isso tem teste com kill de verdade (`FAULT_CRASH_AFTER_COMMIT`, ver testes).
- Classificação de erro:
  - use case retornou (qualquer status, inclusive `REJECTED`): ack.
  - `DomainError` lançado (payload inválido, conflito de idempotência, wallet inexistente): **permanente**, vai direto para a DLQ com o motivo em `MessageAttributes.reason`. Reprocessar não muda o resultado.
  - transitório (banco fora, lock timeout esgotado) ou inesperado: `ChangeMessageVisibility` com backoff de 2^n segundos (máx. 60s). Na entrega número `SQS_MAX_ATTEMPTS` (5), vai para a DLQ com `max_attempts_exceeded`.
- A redrive policy da fila está em 8, acima do limite do consumer. É rede de segurança para quando o próprio envio para a DLQ falha.
- **SIGTERM:** o Nest chama `beforeApplicationShutdown`. O consumer para de buscar, aborta o long-poll em andamento, espera o lote atual terminar (até `SHUTDOWN_GRACE_MS`, 25s) e devolve com visibility 0 as mensagens do lote que nem começaram. O `stop_grace_period` do worker no compose é 40s para caber isso.

## Transactional outbox

Os eventos são gravados em `outbox_messages` na mesma transação da mudança financeira. O `OutboxRelay` roda em cada worker:

1. Abre uma transação e pega um lote com `FOR UPDATE SKIP LOCKED`. Relays concorrentes pegam lotes disjuntos.
2. Publica em `wagering-events.fifo` com `SendMessageBatch`.
3. Marca os publicados com um único UPDATE e reagenda os que falharam (backoff exponencial até 5min, sem limite de tentativas: evento confirmado não pode sumir).
4. Commit.

Se o processo morrer entre publicar e o commit, o lock solta e outro relay publica de novo. A entrega é **at-least-once**. O `MessageDeduplicationId` é o `eventId`, então o próprio SQS descarta a repetição dentro de 5 minutos. Fora dessa janela, o consumidor deduplica pelo `eventId`, que vai no envelope. O teste `outbox` simula exatamente esse crash.

`MessageGroupId` é a wallet, para os eventos de uma mesma wallet saírem em ordem para o consumidor.

Eventos: `WagerTransactionProcessed` (inclusive LOSS e OPENING), `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda) e `WagerTransactionPendingReference`. São classes concretas sobre `IntegrationEvent<T>`, com `eventType` e `version` no tipo. O payload leva `MoneyProps` (string), nunca `Money`.

## Schema

As garantias de unicidade, imutabilidade e não-negatividade estão no banco (`Migration20261012000000_initial.ts`), e cada uma tem teste em SQL puro (`test/integration/schema.test.ts`):

| garantia | como |
|---|---|
| saldo nunca negativo | `CHECK (balance >= 0)` em wallets e nos `balance_before/after` do ledger |
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| idempotência | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| uma reversão por referência | índice único parcial em `reference_transaction_id` para REFUND/ROLLBACK processados |
| no máximo um lançamento por transação/wallet | `UNIQUE (transaction_id, wallet_id)` |
| lançamento com conta certa | `CHECK balance_after = balance_before ± amount` |
| moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency)` → `wallets (id, currency)` |
| ledger encadeado | trigger `BEFORE INSERT`: `balance_before` = `balance_after` do lançamento anterior |
| saldo materializado = ledger | constraint trigger **deferida** em wallets e no ledger: no commit, o último `balance_after` tem que ser igual ao saldo |
| ledger imutável | trigger bloqueando UPDATE, DELETE e TRUNCATE |
| transação terminal imutável | trigger: status terminal não muda, campos de negócio nunca mudam, nada é apagado |
| coerência de status | `CHECK`: `REJECTED/FAILED` exigem `failure_code`; REFUND/ROLLBACK exigem referência; OPENING só interno |

O trigger deferido é o que mais pesa aqui: ele torna impossível commitar uma mudança de saldo sem o lançamento correspondente, ou um lançamento sem a mudança de saldo, mesmo escrevendo SQL na mão. O custo é uma busca indexada por `(wallet_id, seq)` no commit. O ledger tem uma coluna `seq` (identity) que serve para ordenar o encadeamento e como cursor da paginação.

## Observabilidade

- **Logs** em JSON, uma linha por evento (`infra/observability/logger.ts`). `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` entram automaticamente via `AsyncLocalStorage`. O `correlationId` vem do header `X-Correlation-Id`, do envelope da mensagem ou é gerado, e volta no header da resposta.
- **Sem payload e sem valores nos logs.** Só ids, códigos e status. O MikroORM coloca a query (com os valores) na mensagem de erro do driver, então o logger corta essa parte. A única exceção é a divergência de reconciliação, que loga a diferença porque é o que alguém vai precisar para investigar.
- **Métricas** (Prometheus em `/metrics`):

| métrica | |
|---|---|
| `wagering_transactions_total{kind,status}` | transações por status final |
| `wagering_duplicates_detected_total{source,layer}` | duplicatas pela inbox ou pela chave |
| `wagering_idempotency_conflicts_total` | mesma chave, payload diferente |
| `wagering_retries_total{operation,reason}` | retry de transação SQL, de mensagem SQS e de publicação |
| `wagering_lock_conflicts_total{reason}` | deadlock, lock timeout, serialização, conflito de versão |
| `wagering_dlq_messages_total{reason}` e `wagering_dlq_depth` | DLQ |
| `wagering_outbox_pending` e `wagering_outbox_lag_seconds` | outbox lag |
| `wagering_processing_duration_seconds{source,outcome}` | latência do use case |
| `wagering_pending_reference_expired_total` | referências que nunca chegaram |
| `wagering_reconciliation_divergences_total` | reconciliação com diferença |

- **Health:** `/health/live` só responde (processo vivo). `/health/ready` testa `select 1` no Postgres e `GetQueueAttributes` no SQS, com timeout de 2s cada, e responde 503 se algum falhar. Os dois ficam sem autenticação.

## Autenticação

**Decisão: não implementei.** A seção 2 deixa claro que autenticação não pontua, e eu preferi gastar o tempo em concorrência, idempotência e testes de falha.

O ponto de extensão está no código: `ProviderAuthGuard` aplicado nos controllers de negócio (health e métricas ficam de fora) e a porta `ProviderIdentityPort`, cuja implementação atual (`NoAuthProviderIdentity`) não autentica ninguém. O controller já compara o `providerId` autenticado com o do payload quando existe identidade.

Como eu faria:

- **Keycloak** no compose, um realm para provedores, e cada provedor como um *client* confidencial usando **client credentials** (máquina para máquina, sem usuário).
- O `providerId` vai como claim do token (mapper no client). Uma implementação de `ProviderIdentityPort` valida o JWT localmente com o JWKS do realm (cacheado, sem chamar o Keycloak por request), confere `iss`, `aud` e `exp`, e devolve o `providerId`.
- O guard passa a responder 401 sem token e 403 quando o `providerId` do payload é diferente do token. Esse é o ponto que importa para o domínio: um provedor não pode lançar transação em nome de outro.
- Mensagens da fila são canal interno confiável, como o enunciado define, mas o `providerId` delas continua passando pelas mesmas validações de domínio.

## Testes

| suíte | precisa de | cobre |
|---|---|---|
| `test/unit` | nada | Money, Wallet, ledger, todas as regras de BET/WIN/LOSS/REFUND/ROLLBACK, transições de estado, payload hash, outbox/inbox |
| `test/integration` | Postgres + SQS | migrations (desce e sobe), cada constraint e trigger, atomicidade (falha forçada no último insert desfaz tudo), idempotência, inbox e redelivery, dois relays sobre a mesma outbox, crash entre publicar e commitar, retry com backoff e DLQ |
| `test/concurrency` | Postgres + SQS | a mesma aposta 50x em paralelo, duas apostas de 80 com saldo 100 (repetido em 20 wallets), wallets distintas em paralelo, **3 processos** simultâneos, worker morto depois do commit e antes do ack, ROLLBACK/REFUND antes da referência (pela API e pela fila), referência que nunca chega, todas as instâncias mortas com kill -9 no meio da carga e reiniciadas |

Nenhum teste de integração ou concorrência usa mock de Postgres ou SQS. As falhas são provocadas no próprio banco (triggers temporários que lançam erro no ponto exato) ou matando processos. Todos terminam verificando a invariante:

```
wallet.balance == soma do ledger == último balance_after, e nada negativo
```

## Trade-offs e limitações

- **Vazão por wallet é limitada pelo lock.** Para uma wallet só, as operações são serializadas. Isso é intencional (é o que impede lost update) e no teste de carga a hot wallet com 20% do tráfego não virou gargalo, mas uma wallet com milhares de operações por segundo pediria outra abordagem (ex.: sub-saldos).
- **Ordem dos eventos entre relays.** Com vários relays e `SKIP LOCKED`, dois eventos da mesma wallet podem ser publicados fora de ordem se caírem em lotes diferentes. O `WalletBalanceChanged` leva `walletVersion` para o consumidor ordenar ou descartar. Garantir ordem estrita exigiria um relay por partição.
- **O worker de referências faz polling** a cada 1s. Para o volume esperado é simples e suficiente. Com muito volume, eu trocaria por `LISTEN/NOTIFY` ou por uma fila com delay.
- **SIGTERM não tem teste automatizado.** O caminho existe (`beforeApplicationShutdown` no consumer e nos loops), mas os testes de crash usam kill -9, que é o pior caso.
- **Imagem do LocalStack fixada em 3.8.1.** As versões mais novas da imagem pedem token de conta. MiniStack ou ElasticMQ também funcionam: é só apontar `SQS_ENDPOINT` e criar as mesmas filas.
- **A fila de eventos não tem consumidor aqui.** O serviço só publica. A deduplicação por `eventId` é responsabilidade de quem consome.
- **Sem particionamento ou arquivamento do ledger.** Para produção, eu particionaria `wallet_ledger_entries` por tempo e manteria saldo de abertura por partição para a reconciliação não varrer tudo.
