import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 } from "uuid";
import { startTestApp, type TestApp } from "../support/app";
import { wagerBody } from "../support/api";
import { TestDb } from "../support/db";
import { QUEUES, TestSqs } from "../support/sqs";
import { waitFor } from "../support/wait";

const db = new TestDb();
const sqs = new TestSqs();
let t: TestApp;

beforeAll(async () => {
  await sqs.purgeAll();
  t = await startTestApp({ workers: { consumer: true, outbox: false, pendingReferences: false } });
});

afterAll(async () => {
  await t.close();
  await db.close();
});

const processedTx = (providerId: string, externalId: string) =>
  waitFor(
    async () => {
      const rows = await db.transactionsByExternalId(providerId, externalId);
      return rows.length > 0 ? rows : undefined;
    },
    { message: `transaction ${externalId}` },
  );

const queueEmpty = () =>
  waitFor(
    async () => {
      const d = await sqs.depth(QUEUES.wager);
      return d.visible === 0 && d.inFlight === 0;
    },
    { message: "wager queue to drain" },
  );

describe("consumo SQS com inbox", () => {
  test("mesmo messageId entregue duas vezes: um efeito só", async () => {
    const wallet = await t.api.createWallet("100.00");
    const body = wagerBody(wallet, "BET", "10.00");
    const messageId = v7();

    // dedup ids diferentes: o SQS entrega as duas (simula redelivery real)
    await sqs.sendWager(body, { messageId });
    await sqs.sendWager(body, { messageId });

    await processedTx(body.providerId, body.externalTransactionId);
    await queueEmpty();

    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
    const inbox = await db.query(`select * from inbox_messages where message_id = $1`, [messageId]);
    expect(inbox).toHaveLength(1);
    await db.expectWalletConsistent(wallet.walletId);
    expect(await db.balance(wallet.walletId)).toBe("90.00");
  });

  test("messageIds diferentes com a mesma idempotency key: idempotência por chave segura", async () => {
    const wallet = await t.api.createWallet("100.00");
    const body = wagerBody(wallet, "BET", "10.00");
    await sqs.sendWager(body);
    await sqs.sendWager(body);
    await queueEmpty();
    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
  });

  test("HTTP e fila com a mesma chave: um efeito só", async () => {
    const wallet = await t.api.createWallet("100.00");
    const body = wagerBody(wallet, "BET", "10.00");
    const http = await t.api.submit(body);
    expect(http.status).toBe(201);
    await sqs.sendWager(body);
    await queueEmpty();
    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
  });

  test("rejeição de negócio pela fila é persistida e a mensagem é removida (ack)", async () => {
    const wallet = await t.api.createWallet("5.00");
    const body = wagerBody(wallet, "BET", "10.00");
    await sqs.sendWager(body);
    const [tx] = await processedTx(body.providerId, body.externalTransactionId);
    await queueEmpty();
    expect(tx?.status).toBe("REJECTED");
    expect(tx?.failure_code).toBe("INSUFFICIENT_FUNDS");
    expect((await sqs.depth(QUEUES.dlq)).visible).toBe(0);
  });
});
