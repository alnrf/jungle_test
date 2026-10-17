import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { v7 } from "uuid";
import { Metrics } from "../../src/infra/observability/metrics";
import { startTestApp, type TestApp } from "../support/app";
import { wagerBody } from "../support/api";
import { TestDb } from "../support/db";
import { QUEUES, TestSqs } from "../support/sqs";
import { waitFor } from "../support/wait";

const db = new TestDb();
const sqs = new TestSqs();
let t: TestApp;

/*
 * Falha transitória simulada: enquanto a wallet estiver em test_failures,
 * o insert da transação lança lock_not_available (55P03). É o mesmo erro de
 * um lock_timeout de verdade, então passa pelo caminho real:
 * UoW retenta -> desiste -> TransientInfrastructureError -> backoff na fila.
 */
beforeAll(async () => {
  await db.query(`
    create table if not exists test_failures (wallet_id uuid primary key);
    create or replace function test_transient_failure() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from test_failures where wallet_id = new.wallet_id) then
        raise exception 'simulated lock timeout' using errcode = '55P03';
      end if;
      return new;
    end;
    $$;
    drop trigger if exists trg_test_transient on wager_transactions;
    create trigger trg_test_transient before insert on wager_transactions
      for each row execute function test_transient_failure();
  `);
  await sqs.purgeAll();
  t = await startTestApp({
    env: { SQS_MAX_ATTEMPTS: "3" },
    workers: { consumer: true, outbox: false, pendingReferences: false },
  });
});

beforeEach(() => db.query(`delete from test_failures`));

afterAll(async () => {
  await db.query(`
    drop trigger if exists trg_test_transient on wager_transactions;
    drop function if exists test_transient_failure();
    drop table if exists test_failures;
  `);
  await t.close();
  await db.close();
});

const breakWallet = (walletId: string) => db.query(`insert into test_failures values ($1)`, [walletId]);

const dlqReasons = async () => {
  const messages = await sqs.drain(QUEUES.dlq, 2_000);
  return messages.map((m) => m.MessageAttributes?.reason?.StringValue);
};

const dlqHasMessages = () =>
  waitFor(async () => (await sqs.depth(QUEUES.dlq)).visible > 0, { message: "message in DLQ", timeoutMs: 30_000 });

async function sqsRetries(metrics: Metrics): Promise<number> {
  const { values } = await metrics.retries.get();
  return values.filter((v) => v.labels.operation === "sqs_message").reduce((acc, v) => acc + v.value, 0);
}

describe("retry e DLQ", () => {
  test("JSON inválido vai direto pra DLQ", async () => {
    await sqs.sendRaw("{not json", "bad-1");
    await dlqHasMessages();
    expect(await dlqReasons()).toContain("invalid_message");
  });

  test("payload que não passa na validação vai direto pra DLQ", async () => {
    await sqs.sendRaw(JSON.stringify({ messageId: v7(), type: "WagerTransactionRequested", data: {} }), "bad-2");
    await dlqHasMessages();
    expect(await dlqReasons()).toContain("invalid_message");
  });

  test("wallet inexistente é permanente: DLQ", async () => {
    await sqs.sendWager(wagerBody({ walletId: v7(), playerId: v7() }, "BET", "1.00"));
    await dlqHasMessages();
    expect(await dlqReasons()).toContain("wallet_not_found");
  });

  test("falha transitória: volta pra fila com backoff e processa depois, sem duplicar", async () => {
    const wallet = await t.api.createWallet("100.00");
    await breakWallet(wallet.walletId);
    const metrics = t.app.get(Metrics, { strict: false });
    const before = await sqsRetries(metrics);

    const body = wagerBody(wallet, "BET", "10.00");
    await sqs.sendWager(body);

    // primeira entrega falha inteira e a mensagem volta pra fila
    await waitFor(async () => (await sqsRetries(metrics)) > before, { message: "sqs retry" });
    await db.query(`delete from test_failures`);

    await waitFor(
      async () => (await db.transactionsByExternalId(body.providerId, body.externalTransactionId)).length === 1,
      { message: "message processed after retry", timeoutMs: 20_000 },
    );
    expect(await db.ledgerCount(wallet.walletId, "DEBIT")).toBe(1);
    await db.expectWalletConsistent(wallet.walletId);
  });

  test("falha transitória que não passa: depois de SQS_MAX_ATTEMPTS vai pra DLQ sem efeito nenhum", async () => {
    const wallet = await t.api.createWallet("100.00");
    await breakWallet(wallet.walletId);
    const body = wagerBody(wallet, "BET", "10.00");
    const messageId = await sqs.sendWager(body);

    // SQS_MAX_ATTEMPTS=3: backoff de 2s e 4s e na terceira vai pra DLQ
    await dlqHasMessages();
    expect(await dlqReasons()).toContain("max_attempts_exceeded");
    expect(await db.transactionsByExternalId(body.providerId, body.externalTransactionId)).toHaveLength(0);
    expect(await db.balance(wallet.walletId)).toBe("100.00");
    // a inbox é gravada na mesma transação: sem commit, sem registro
    expect(await db.query(`select 1 from inbox_messages where message_id = $1`, [messageId])).toHaveLength(0);
  });
});
