import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../support/app";
import { wagerBody } from "../support/api";
import { TestDb } from "../support/db";

/*
 * Paralelismo de verdade: as requisições saem todas juntas e o pool do app
 * tem várias conexões, então elas disputam o lock da wallet no Postgres.
 */

const db = new TestDb();
let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ env: { DB_POOL_MAX: "30" } });
});

afterAll(async () => {
  await t.close();
  await db.close();
});

describe("concorrência na mesma wallet", () => {
  test("a mesma aposta enviada 50 vezes em paralelo debita uma vez só", async () => {
    const wallet = await t.api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "10.00");

    const results = await Promise.all(Array.from({ length: 50 }, () => t.api.submit(bet)));

    const fresh = results.filter((r) => r.status === 201);
    const replays = results.filter((r) => r.status === 200 && r.body.idempotentReplay);
    expect(fresh).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    // todo mundo vê o mesmo saldo: o do momento em que a aposta foi aplicada
    expect(new Set(results.map((r) => r.body.balance?.amount))).toEqual(new Set(["90.00"]));

    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("90.00");
  });

  test("duas apostas de 80 com saldo 100: uma passa, a outra é rejeitada (repetido em 20 wallets)", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => t.api.createWallet("100.00")));

    await Promise.all(
      wallets.map(async (wallet) => {
        const [a, b] = await Promise.all([
          t.api.submit(wagerBody(wallet, "BET", "80.00")),
          t.api.submit(wagerBody(wallet, "BET", "80.00")),
        ]);
        const statuses = [a.body.status, b.body.status].sort();
        expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
        const rejected = a.body.status === "REJECTED" ? a : b;
        expect(rejected.status).toBe(422);
        expect(rejected.body.failureCode).toBe("INSUFFICIENT_FUNDS");

        const { balance } = await db.expectWalletConsistent(wallet.walletId);
        expect(balance).toBe("20.00");
        expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
      }),
    );
  });

  test("retry das duas apostas não duplica o débito", async () => {
    const wallet = await t.api.createWallet("100.00");
    const a = wagerBody(wallet, "BET", "80.00");
    const b = wagerBody(wallet, "BET", "80.00");
    await Promise.all([t.api.submit(a), t.api.submit(b)]);
    // provedor reenvia as duas, várias vezes, em paralelo
    await Promise.all(Array.from({ length: 10 }, (_, i) => t.api.submit(i % 2 ? a : b)));

    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
    expect((await db.expectWalletConsistent(wallet.walletId)).balance).toBe("20.00");
  });

  test("100 operações misturadas na mesma wallet: saldo nunca negativo e bate com o ledger", async () => {
    const wallet = await t.api.createWallet("50.00");
    const ops = Array.from({ length: 100 }, (_, i) =>
      i % 3 === 0 ? wagerBody(wallet, "WIN", "7.00") : wagerBody(wallet, "BET", "9.00"),
    );
    const results = await Promise.all(ops.map((op) => t.api.submit(op)));
    expect(results.every((r) => [201, 422].includes(r.status))).toBe(true);

    const processed = results.filter((r) => r.body.status === "PROCESSED").length;
    const { entries } = await db.expectWalletConsistent(wallet.walletId);
    expect(entries).toBe(processed + 1); // + abertura
  });
});

describe("wallets diferentes em paralelo", () => {
  test("20 wallets x 10 apostas, tudo ao mesmo tempo", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => t.api.createWallet("100.00")));

    const started = performance.now();
    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 10 }, () => t.api.submit(wagerBody(wallet, "BET", "7.50"))),
      ),
    );
    const elapsed = performance.now() - started;

    for (const wallet of wallets) {
      const { balance } = await db.expectWalletConsistent(wallet.walletId);
      expect(balance).toBe("25.00");
    }
    // não é benchmark, só garante que wallets diferentes não ficam em fila única
    expect(elapsed).toBeLessThan(30_000);
  });
});
