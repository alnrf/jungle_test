import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../support/app";
import { wagerBody } from "../support/api";
import { TestDb } from "../support/db";
import { TestSqs } from "../support/sqs";
import { waitFor } from "../support/wait";

const db = new TestDb();
const sqs = new TestSqs();
let t: TestApp;

beforeAll(async () => {
  await sqs.purgeAll();
  t = await startTestApp({
    env: {
      PENDING_REFERENCE_BASE_DELAY_MS: "200",
      PENDING_REFERENCE_MAX_ATTEMPTS: "3",
    },
    workers: { consumer: true, outbox: false, pendingReferences: true },
  });
});

afterAll(async () => {
  await t.close();
  await db.close();
});

const status = async (externalId: string) =>
  (await db.transactionsByExternalId("provider-test", externalId))[0];

describe("referência fora de ordem", () => {
  test("ROLLBACK antes do BET (HTTP): fica PENDING_REFERENCE e é aplicado quando o BET chega", async () => {
    const wallet = await t.api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "30.00");
    const rollback = wagerBody(wallet, "ROLLBACK", "30.00", { referenceExternalTransactionId: bet.externalTransactionId });

    const pending = await t.api.submit(rollback);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe("PENDING_REFERENCE");

    await t.api.submit(bet);
    const rb = await status(rollback.externalTransactionId);
    expect(rb?.status).toBe("PROCESSED");
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("100.00");
  });

  test("REFUND antes do BET pela fila, com mensagens em grupos diferentes", async () => {
    const wallet = await t.api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "40.00");
    const refund = wagerBody(wallet, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId });

    await sqs.sendWager(refund);
    await waitFor(async () => (await status(refund.externalTransactionId))?.status === "PENDING_REFERENCE", {
      message: "refund pending",
    });
    await sqs.sendWager(bet);

    await waitFor(async () => (await status(refund.externalTransactionId))?.status === "PROCESSED", {
      message: "refund processed",
    });
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("100.00");
    expect(await db.ledgerCount(wallet.walletId)).toBe(3);
  });

  test("referência que nunca chega: REJECTED com REFERENCE_NOT_FOUND e evento publicado na outbox", async () => {
    const wallet = await t.api.createWallet("100.00");
    const refund = wagerBody(wallet, "REFUND", "10.00", { referenceExternalTransactionId: "never-arrives" });
    await t.api.submit(refund);

    // 3 tentativas com base 200ms: 200 + 400 + 800ms
    const final = await waitFor(
      async () => {
        const s = await status(refund.externalTransactionId);
        return s?.status === "REJECTED" ? s : undefined;
      },
      { message: "refund expired", timeoutMs: 10_000 },
    );
    expect(final.failure_code).toBe("REFERENCE_NOT_FOUND");

    const events = await db.query<{ event_type: string }>(
      `select event_type from outbox_messages where aggregate_id = $1 order by occurred_at`,
      [final.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("100.00");
  });

  test("referência que chega depois de algumas checagens do worker ainda é aplicada", async () => {
    const wallet = await t.api.createWallet("100.00");
    const win = wagerBody(wallet, "WIN", "25.00");
    const rollback = wagerBody(wallet, "ROLLBACK", "25.00", { referenceExternalTransactionId: win.externalTransactionId });

    await t.api.submit(rollback);
    await waitFor(
      async () => {
        const [row] = await db.query<{ reference_attempts: number }>(
          `select reference_attempts from wager_transactions where external_transaction_id = $1`,
          [rollback.externalTransactionId],
        );
        return (row?.reference_attempts ?? 0) >= 1;
      },
      { message: "worker to retry once" },
    );
    await t.api.submit(win);

    const rb = await status(rollback.externalTransactionId);
    expect(rb?.status).toBe("PROCESSED");
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("100.00");
  });

  test("referência rejeitada: o dependente também é rejeitado", async () => {
    const wallet = await t.api.createWallet("10.00");
    const bet = wagerBody(wallet, "BET", "50.00"); // sem saldo
    const refund = wagerBody(wallet, "REFUND", "50.00", { referenceExternalTransactionId: bet.externalTransactionId });
    await t.api.submit(refund);
    await t.api.submit(bet);

    const rf = await status(refund.externalTransactionId);
    expect(rf?.status).toBe("REJECTED");
    expect(rf?.failure_code).toBe("REFERENCE_NOT_PROCESSED");
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("10.00");
  });

});
