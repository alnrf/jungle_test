/**
 * Teste de carga simples contra uma instância (ou o gateway) já rodando.
 *
 *   BASE_URL=http://localhost:3000 DURATION_S=30 CONCURRENCY=50 bun run test:load
 *
 * Mistura: 70% BET, 20% WIN, 10% reenvio de uma operação já feita (replay).
 * Uma parte do tráfego vai pra uma "hot wallet" pra medir contenção de lock.
 * No final reconcilia todas as wallets: carga que deixa saldo errado não conta.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { v7 } from "uuid";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DURATION_S = Number(process.env.DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const WALLETS = Number(process.env.WALLETS ?? 50);
const HOT_SHARE = Number(process.env.HOT_SHARE ?? 0.2);

interface Op {
  key: string;
  body: Record<string, unknown>;
}

const latencies: number[] = [];
const statusCounts = new Map<number, number>();
const sent: Op[] = [];
let networkErrors = 0;
let maxOutboxLag = 0;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function metric(name: string): Promise<number> {
  const text = await (await fetch(`${BASE_URL}/metrics`)).text();
  return text
    .split("\n")
    .filter((l) => l.startsWith(name) && !l.startsWith("#"))
    .reduce((acc, l) => acc + Number(l.split(" ").pop()), 0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main() {
  console.log(`setup: ${WALLETS} wallets em ${BASE_URL}`);
  const wallets = await Promise.all(
    Array.from({ length: WALLETS }, async () => {
      const playerId = v7();
      const res = await post("/wallets", { playerId, initialBalance: { amount: "100000.00", currency: "BRL" } });
      const body = (await res.json()) as { id: string };
      return { walletId: body.id, playerId };
    }),
  );
  const hot = wallets[0]!;

  const lockConflictsBefore = await metric("wagering_lock_conflicts_total");
  const retriesBefore = await metric("wagering_retries_total");

  const deadline = Date.now() + DURATION_S * 1000;
  const sampler = setInterval(async () => {
    try {
      maxOutboxLag = Math.max(maxOutboxLag, await metric("wagering_outbox_lag_seconds"));
    } catch {
      /* ignora */
    }
  }, 1000);

  const worker = async () => {
    while (Date.now() < deadline) {
      const roll = Math.random();
      let op: Op;
      if (roll < 0.1 && sent.length > 0) {
        op = sent[Math.floor(Math.random() * sent.length)]!;
      } else {
        const wallet = Math.random() < HOT_SHARE ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
        const externalTransactionId = v7();
        op = {
          key: `load:${externalTransactionId}`,
          body: {
            providerId: "load",
            externalTransactionId,
            playerId: wallet.playerId,
            walletId: wallet.walletId,
            roundId: v7(),
            gameId: "load-test",
            kind: roll < 0.8 ? "BET" : "WIN",
            money: { amount: roll < 0.8 ? "1.00" : "0.90", currency: "BRL" },
          },
        };
        sent.push(op);
      }

      const started = performance.now();
      try {
        const res = await post("/wagering/transactions", op.body, { "Idempotency-Key": op.key });
        await res.arrayBuffer();
        latencies.push(performance.now() - started);
        statusCounts.set(res.status, (statusCounts.get(res.status) ?? 0) + 1);
      } catch {
        networkErrors++;
      }
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedS = (performance.now() - startedAt) / 1000;
  clearInterval(sampler);

  const lockConflicts = (await metric("wagering_lock_conflicts_total")) - lockConflictsBefore;
  const retries = (await metric("wagering_retries_total")) - retriesBefore;

  // espera a outbox esvaziar e mede quanto demorou
  const drainStart = Date.now();
  while ((await metric("wagering_outbox_pending")) > 0 && Date.now() - drainStart < 60_000) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const drainS = (Date.now() - drainStart) / 1000;

  let inconsistent = 0;
  for (const w of wallets) {
    const res = await post(`/wallets/${w.walletId}/reconciliation`, {});
    const body = (await res.json()) as { consistent: boolean };
    if (!body.consistent) inconsistent++;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.length + networkErrors;
  const errors5xx = [...statusCounts].filter(([s]) => s >= 500).reduce((a, [, n]) => a + n, 0);
  const report = `# Resultado do teste de carga

- data: ${new Date().toISOString()}
- alvo: ${BASE_URL}
- duração: ${elapsedS.toFixed(1)}s, concorrência: ${CONCURRENCY}, wallets: ${WALLETS} (hot wallet com ${HOT_SHARE * 100}% do tráfego)

| métrica | valor |
|---|---|
| requisições | ${total} |
| throughput | ${(latencies.length / elapsedS).toFixed(1)} req/s |
| p50 | ${percentile(sorted, 50).toFixed(1)} ms |
| p95 | ${percentile(sorted, 95).toFixed(1)} ms |
| p99 | ${percentile(sorted, 99).toFixed(1)} ms |
| máx | ${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms |
| erros 5xx | ${errors5xx} (${((errors5xx / Math.max(total, 1)) * 100).toFixed(2)}%) |
| erros de rede | ${networkErrors} |
| status | ${[...statusCounts].sort().map(([s, n]) => `${s}: ${n}`).join(", ")} |
| conflitos de lock (métrica) | ${lockConflicts} |
| retries (métrica) | ${retries} |
| outbox lag máximo amostrado | ${maxOutboxLag.toFixed(2)} s |
| tempo pra outbox zerar depois da carga | ${drainS.toFixed(1)} s |
| wallets inconsistentes na reconciliação | ${inconsistent} |
`;
  console.log(report);
  mkdirSync(".load-results", { recursive: true });
  writeFileSync(`.load-results/${Date.now()}.md`, report);
  if (inconsistent > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
