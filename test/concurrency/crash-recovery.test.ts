import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { wagerBody, type WagerBody } from "../support/api";
import { TestDb } from "../support/db";
import { spawnInstance, type Instance } from "../support/processes";
import { QUEUES, TestSqs } from "../support/sqs";
import { sleep, waitFor } from "../support/wait";

const db = new TestDb();
const sqs = new TestSqs();
const running: Instance[] = [];

async function start(name: string, env: Record<string, string> = {}) {
  const instance = await spawnInstance(name, env);
  running.push(instance);
  return instance;
}

beforeAll(() => sqs.purgeAll());

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.kill().catch(() => undefined)));
});

afterAll(() => db.close());

const queueDrained = (timeoutMs = 60_000) =>
  waitFor(
    async () => {
      const d = await sqs.depth(QUEUES.wager);
      return d.visible === 0 && d.inFlight === 0;
    },
    { timeoutMs, message: "wager queue drained" },
  );

describe("falhas de processo", () => {
  test("worker morre depois do commit e antes do ack: outro worker reprocessa sem duplicar", async () => {
    const crashing = await start("crashing-worker", {
      FAULT_CRASH_AFTER_COMMIT: "true",
      SQS_VISIBILITY_TIMEOUT: "3",
    });
    const wallet = await crashing.api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "10.00");
    const messageId = await sqs.sendWager(bet);

    const exitCode = await Promise.race([crashing.exited, sleep(20_000).then(() => "timeout")]);
    expect(exitCode).toBe(137);

    // commit aconteceu
    expect(await db.transactionsByExternalId(bet.providerId, bet.externalTransactionId)).toHaveLength(1);
    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
    // ack não: a mensagem continua na fila (invisível até o timeout)
    const depth = await sqs.depth(QUEUES.wager);
    expect(depth.visible + depth.inFlight).toBe(1);

    await start("healthy-worker");
    await queueDrained();

    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
    const inbox = await db.query(`select 1 from inbox_messages where message_id = $1`, [messageId]);
    expect(inbox).toHaveLength(1);
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("90.00");
  }, 90_000);

  test("instâncias mortas no meio da carga e reiniciadas: estado final consistente", async () => {
    const fleet = await Promise.all([1, 2, 3].map((n) => start(`fleet-${n}`, { SQS_VISIBILITY_TIMEOUT: "3" })));
    const wallets = await Promise.all(Array.from({ length: 5 }, () => fleet[0]!.api.createWallet("1000.00")));

    const ops: WagerBody[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 40; i++) {
        ops.push(i % 5 === 0 ? wagerBody(wallet, "WIN", "4.00") : wagerBody(wallet, "BET", "6.00"));
      }
    }
    await Promise.all(ops.map((op) => sqs.sendWager(op)));

    // deixa processar um pouco e derruba todo mundo (kill -9)
    await sleep(1_500);
    await Promise.all(fleet.map((i) => i.kill("SIGKILL")));
    running.splice(0);

    const midway = await db.one<{ n: number }>(
      `select count(*)::int as n from wager_transactions where external_transaction_id = any($1)`,
      [ops.map((o) => o.externalTransactionId)],
    );

    // reinício
    await Promise.all([1, 2, 3].map((n) => start(`fleet-restarted-${n}`)));
    await queueDrained(90_000);

    const final = await db.query<{ external_transaction_id: string; n: number }>(
      `select external_transaction_id, count(*)::int as n from wager_transactions
        where external_transaction_id = any($1) group by external_transaction_id`,
      [ops.map((o) => o.externalTransactionId)],
    );
    expect(final).toHaveLength(ops.length);
    expect(final.every((r) => r.n === 1)).toBe(true);
    expect(midway.n).toBeLessThanOrEqual(ops.length);

    for (const wallet of wallets) {
      await db.expectWalletConsistent(wallet.walletId);
      const reconcile = await running[0]!.api.request<{ consistent: boolean }>(
        "POST",
        `/wallets/${wallet.walletId}/reconciliation`,
      );
      expect(reconcile.body.consistent).toBe(true);
    }

    // eventos confirmados antes do kill também saem
    await waitFor(
      async () => {
        const [row] = await db.query<{ n: number }>(
          `select count(*)::int as n from outbox_messages where published_at is null`,
        );
        return row?.n === 0;
      },
      { timeoutMs: 60_000, message: "outbox drained after restart" },
    );
  }, 180_000);
});
