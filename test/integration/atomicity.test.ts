import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../support/app";
import { wagerBody } from "../support/api";
import { TestDb } from "../support/db";

/*
 * Força uma falha no ÚLTIMO passo da transação (insert na outbox) e confere
 * que nada dos passos anteriores sobreviveu: nem transação, nem ledger, nem
 * saldo. O caso da inbox (entrada pela fila) está em sqs-retry-dlq.test.ts.
 */

const db = new TestDb();
let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
  await db.query(`
    create or replace function test_fail_outbox() returns trigger language plpgsql as $$
    begin
      if new.payload::text like '%atomicity-boom%' then
        raise exception 'simulated outbox failure';
      end if;
      return new;
    end;
    $$;
    drop trigger if exists trg_test_fail_outbox on outbox_messages;
    create trigger trg_test_fail_outbox before insert on outbox_messages
      for each row execute function test_fail_outbox();
  `);
});

afterAll(async () => {
  await db.query(`drop trigger if exists trg_test_fail_outbox on outbox_messages; drop function if exists test_fail_outbox();`);
  await t.close();
  await db.close();
});

describe("atomicidade wallet + ledger + transação + outbox", () => {
  test("falha na outbox desfaz tudo", async () => {
    const wallet = await t.api.createWallet("100.00");
    const body = wagerBody(wallet, "BET", "30.00", { roundId: "atomicity-boom" });

    const res = await t.api.submit(body);
    expect(res.status).toBe(500);

    expect(await db.transactionsByExternalId(body.providerId, body.externalTransactionId)).toHaveLength(0);
    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(0);
    expect(await db.balance(wallet.walletId)).toBe("100.00");
    const version = await db.one<{ version: number }>(`select version from wallets where id = $1`, [wallet.walletId]);
    expect(version.version).toBe(1);
    await db.expectWalletConsistent(wallet.walletId);
  });

  test("depois que a falha some, o mesmo request é aceito normalmente (nada ficou meio gravado)", async () => {
    const wallet = await t.api.createWallet("100.00");
    const body = wagerBody(wallet, "BET", "30.00", { roundId: "atomicity-boom" });
    expect((await t.api.submit(body)).status).toBe(500);

    const fixed = { ...body, roundId: "round-ok", externalTransactionId: `${body.externalTransactionId}-ok` };
    const ok = await t.api.submit(fixed);
    expect(ok.status).toBe(201);
    expect(ok.body.balance?.amount).toBe("70.00");
    await db.expectWalletConsistent(wallet.walletId);
  });

  test("abertura da wallet é atômica com o lançamento de OPENING", async () => {
    const wallet = await t.api.createWallet("250.00");
    const rows = await db.query<{ kind: string; direction: string; amount: string }>(
      `select t.kind, l.direction, l.amount
         from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
        where l.wallet_id = $1`,
      [wallet.walletId],
    );
    expect(rows).toEqual([{ kind: "OPENING", direction: "CREDIT", amount: "250.00" }]);
    const events = await db.query<{ event_type: string }>(
      `select event_type from outbox_messages where payload->'data'->>'walletId' = $1 order by event_type`,
      [wallet.walletId],
    );
    expect(events.map((e) => e.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });
});
