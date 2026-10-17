import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { wagerBody, type WagerBody } from "../support/api";
import { TestDb } from "../support/db";
import { spawnInstance, type Instance } from "../support/processes";
import { QUEUES, TestSqs } from "../support/sqs";
import { waitFor } from "../support/wait";

/*
 * Três processos independentes (cada um com seu pool, consumer, relay e
 * worker), apontando pro mesmo Postgres e pras mesmas filas.
 */

const db = new TestDb();
const sqs = new TestSqs();
let instances: Instance[] = [];

beforeAll(async () => {
  await sqs.purgeAll();
  instances = await Promise.all([1, 2, 3].map((n) => spawnInstance(`instance-${n}`)));
}, 90_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.kill()));
  await db.close();
});

const pick = (i: number) => instances[i % instances.length]!;

async function queueDrained() {
  await waitFor(
    async () => {
      const d = await sqs.depth(QUEUES.wager);
      return d.visible === 0 && d.inFlight === 0;
    },
    { timeoutMs: 60_000, message: "wager queue drained" },
  );
}

async function outboxDrained() {
  await waitFor(
    async () => {
      const [row] = await db.query<{ n: number }>(`select count(*)::int as n from outbox_messages where published_at is null`);
      return row?.n === 0;
    },
    { timeoutMs: 60_000, message: "outbox drained" },
  );
}

describe("3 instâncias simultâneas", () => {
  test("hot wallet recebendo HTTP nas 3 instâncias e pela fila ao mesmo tempo", async () => {
    const wallet = await pick(0).api.createWallet("500.00");
    const ops: WagerBody[] = [];
    for (let i = 0; i < 120; i++) {
      ops.push(i % 4 === 0 ? wagerBody(wallet, "WIN", "3.00") : wagerBody(wallet, "BET", "7.00"));
    }

    // metade por HTTP espalhado nas instâncias, metade pela fila
    // (e cada operação HTTP também é reenviada pela fila: duplicata entre canais)
    await Promise.all([
      ...ops.slice(0, 60).map((op, i) => pick(i).api.submit(op)),
      ...ops.slice(0, 60).map((op) => sqs.sendWager(op)),
      ...ops.slice(60).map((op) => sqs.sendWager(op)),
    ]);
    await queueDrained();

    const rows = await db.query<{ external_transaction_id: string; n: number }>(
      `select external_transaction_id, count(*)::int as n
         from wager_transactions where wallet_id = $1 and kind <> 'OPENING'
        group by external_transaction_id`,
      [wallet.walletId],
    );
    expect(rows).toHaveLength(ops.length);
    expect(rows.every((r) => r.n === 1)).toBe(true);

    const processed = await db.one<{ n: number }>(
      `select count(*)::int as n from wager_transactions where wallet_id = $1 and status = 'PROCESSED' and kind <> 'OPENING'`,
      [wallet.walletId],
    );
    const { entries } = await db.expectWalletConsistent(wallet.walletId);
    expect(entries).toBe(processed.n + 1);
  }, 90_000);

  test("duas apostas de 80 com saldo 100, cada uma numa instância", async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await pick(round).api.createWallet("100.00");
      const results = await Promise.all([
        pick(round).api.submit(wagerBody(wallet, "BET", "80.00")),
        pick(round + 1).api.submit(wagerBody(wallet, "BET", "80.00")),
      ]);
      expect(results.map((r) => r.body.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
      expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("20.00");
    }
  });

  test("a mesma aposta mandada 30x em cada instância (90 em paralelo): um débito", async () => {
    const wallet = await pick(0).api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "10.00");
    const results = await Promise.all(Array.from({ length: 90 }, (_, i) => pick(i).api.submit(bet)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(89);
    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
  });

  test("3 relays de outbox concorrentes publicam tudo", async () => {
    await outboxDrained();
  }, 90_000);
});
