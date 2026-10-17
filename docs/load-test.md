# Teste de carga

Script: `test/load/load.ts` (`bun run test:load`). Ele roda contra uma instância já de pé e no final reconcilia todas as wallets usadas. Uma carga que termina com saldo errado não vale como resultado.

## Ambiente

Tudo na mesma máquina, então cliente, aplicação, banco e fila disputam CPU. Os números servem para comparar mudanças, não como capacidade de produção.

- notebook com Intel Core Ultra 7 258V (8 threads), 32 GB RAM e Windows 11
- 1 instância da aplicação com `APP_ROLE=all` (HTTP, consumer, relay e worker no mesmo processo), Bun 1.4.3, pool de 20 conexões, logs em nível `info` indo para arquivo
- PostgreSQL 17 local, sem tuning
- SQS: ElasticMQ local (mesma API, mesmas filas FIFO)

## Metodologia

```bash
DURATION_S=30 CONCURRENCY=50 WALLETS=50 HOT_SHARE=0.2 bun run test:load
```

- 50 clientes concorrentes em loop fechado (cada um manda a próxima requisição quando a anterior volta), por 30s.
- 50 wallets com saldo alto. 20% do tráfego vai para uma única wallet (hot wallet), para medir a contenção do lock. O resto é distribuído aleatoriamente.
- Mistura: 70% BET, 20% WIN e 10% reenvio de uma operação já feita (tem que voltar 200 com replay).
- Coleta: latência do lado do cliente, status HTTP, `wagering_lock_conflicts_total` e `wagering_retries_total` antes e depois, `wagering_outbox_lag_seconds` amostrado a cada segundo, tempo para a outbox zerar depois da carga e reconciliação de todas as wallets.

## Resultados

Rodei duas vezes. A primeira mostrou um gargalo na outbox, corrigi e rodei de novo.

| métrica | 1ª rodada | 2ª rodada (relay com update em lote) |
|---|---|---|
| requisições | 9684 | 10096 |
| throughput | 321 req/s | 335 req/s |
| p50 | 123 ms | 116 ms |
| p95 | 400 ms | 408 ms |
| p99 | 512 ms | 519 ms |
| máx | 752 ms | 1145 ms |
| erros (5xx / rede) | 0 / 0 | 0 / 0 |
| status | 201: 8790, 200: 894 | 201: 9060, 200: 1036 |
| conflitos de lock | 0 | 0 |
| retries | 0 | 0 |
| outbox lag máximo | **19.6 s** | **0.5 s** |
| outbox zerada depois da carga em | 10.1 s | 1.5 s |
| wallets inconsistentes | 0 | 0 |

## Análise

**Outbox.** Na primeira rodada a API aguentou, mas a outbox foi ficando para trás: chegou a ter eventos esperando quase 20s. O relay publicava em lote, mas depois gravava um UPDATE por evento dentro da transação que segura o lote. Com uns 700 eventos por segundo (cada aposta gera 2), isso não fechava a conta. Troquei por um UPDATE único para todos os publicados do lote (os que falham continuam sendo atualizados um a um, com o backoff) e subi o lote padrão de 50 para 200. O lag caiu para meio segundo, sem mudar a vazão da API.

**Latência.** O p95 em torno de 400ms vem principalmente da hot wallet. As requisições dela ficam na fila do `FOR UPDATE`, e com 50 clientes e 20% do tráfego numa wallet só, sempre tem uns 10 esperando. É o custo esperado do lock pessimista. Não apareceu nenhum lock timeout, deadlock ou retry (os contadores ficaram em zero), ou seja, a espera é fila, não conflito. Wallets que não são a quente respondem bem mais rápido, mas o script não separa as duas latências. Seria a próxima melhoria do script.

**O que não dá para concluir daqui:** comportamento com várias instâncias e um Postgres separado, porque tudo rodou na mesma máquina. O teste `multi-instance` cobre correção com 3 processos, não desempenho. O máximo de 1145ms na segunda rodada é um ponto isolado. Com tudo dividindo a mesma CPU, não investiguei mais.

**Correção sob carga:** as 50 wallets fecharam com saldo igual ao ledger nas duas rodadas, e os 10% de reenvios voltaram como replay (200), sem débito duplicado.
