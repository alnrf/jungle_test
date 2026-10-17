import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../support/app";
import { wagerBody } from "../support/api";
import { TestDb } from "../support/db";

const db = new TestDb();
let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t.close();
  await db.close();
});

describe("idempotência pela API", () => {
  test("replay devolve o resultado original, inclusive o saldo daquele momento", async () => {
    const wallet = await t.api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "10.00");
    const first = await t.api.submit(bet);
    // muda o saldo depois
    await t.api.submit(wagerBody(wallet, "BET", "50.00"));

    const replay = await t.api.submit(bet);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance?.amount).toBe("90.00");
    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(2);
  });

  test("replay de rejeição devolve a mesma rejeição", async () => {
    const wallet = await t.api.createWallet("5.00");
    const bet = wagerBody(wallet, "BET", "10.00");
    const first = await t.api.submit(bet);
    const replay = await t.api.submit(bet);
    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("mesma chave com payload diferente é conflito e não mexe em nada", async () => {
    const wallet = await t.api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "10.00");
    await t.api.submit(bet);
    const conflict = await t.api.submit({ ...bet, money: { amount: "11.00", currency: "BRL" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(await db.balance(wallet.walletId)).toBe("90.00");
  });

  test("externalTransactionId reaproveitado com outra chave é conflito", async () => {
    const wallet = await t.api.createWallet("100.00");
    const bet = wagerBody(wallet, "BET", "10.00");
    await t.api.submit(bet, "key-a");
    const res = await t.api.submit(bet, "key-b");
    expect(res.status).toBe(409);
  });

  test("Idempotency-Key ausente é 400", async () => {
    const wallet = await t.api.createWallet("100.00");
    const res = await t.api.request("POST", "/wagering/transactions", wagerBody(wallet, "BET", "1.00"));
    expect(res.status).toBe(400);
  });

  test("wallet duplicada é 409", async () => {
    const wallet = await t.api.createWallet("1.00");
    const res = await t.api.request("POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "1.00", currency: "BRL" },
    });
    expect(res.status).toBe(409);
  });

  test("mesmo player pode ter wallet em outra moeda; conflito de moeda na aposta é REJECTED", async () => {
    const wallet = await t.api.createWallet("10.00");
    const usd = await t.api.request<{ id: string }>("POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "10.00", currency: "USD" },
    });
    expect(usd.status).toBe(201);

    const res = await t.api.submit(wagerBody(wallet, "BET", "1.00", { money: { amount: "1.00", currency: "USD" } }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("CURRENCY_MISMATCH");
    await db.expectWalletConsistent(wallet.walletId);
  });
});
