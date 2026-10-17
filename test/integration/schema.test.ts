import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 } from "uuid";
import { buildOrmConfig } from "../../src/infra/database/mikro-orm.config";
import { TestDb } from "../support/db";
import { testEnv } from "../support/env";

/*
 * As garantias do schema testadas direto em SQL, sem passar pela aplicação.
 * Se alguém "esquecer" uma regra no código, o banco ainda segura.
 */

const db = new TestDb();

beforeAll(async () => {
  // migration é reversível: desce e sobe de novo
  const orm = await MikroORM.init(buildOrmConfig(testEnv()));
  try {
    const migrator = orm.getMigrator();
    await migrator.up();
    const reverted = await migrator.down();
    expect(reverted.length).toBe(1);
    const tables = await orm.em.getConnection().execute(`select to_regclass('wallets') as t`);
    expect(tables[0]?.t).toBeNull();
    await migrator.up();
  } finally {
    await orm.close(true);
  }
});

afterAll(() => db.close());

async function expectError(sql: string, params: unknown[], code: string, pattern?: RegExp) {
  try {
    await db.query(sql, params);
  } catch (err) {
    const e = err as { code?: string; message: string };
    expect(e.code).toBe(code);
    if (pattern) expect(e.message).toMatch(pattern);
    return;
  }
  throw new Error(`expected ${code} for: ${sql}`);
}

/** Cria wallet + lançamento de abertura numa transação, como a aplicação faz. */
async function seedWallet(balance = "100.00") {
  const walletId = v7();
  const playerId = v7();
  const txId = v7();
  await db.query(
    `with w as (
       insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values ($1, $2, 'BRL', $4, 1, now(), now())
     ), t as (
       insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at, updated_at)
       values ($3, 'internal', 'opening:' || $1, 'opening:' || $1, repeat('0', 64),
         $1, $2, 'opening', 'internal', 'OPENING', $4, 'BRL', 'PROCESSED', now(), now(), now())
     )
     insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     values (gen_random_uuid(), $1, $3, 'CREDIT', $4, 'BRL', 0, $4, now())`,
    [walletId, playerId, txId, balance],
  );
  return { walletId, playerId, openingTxId: txId };
}

async function insertBet(walletId: string, playerId: string, extra: Record<string, string> = {}) {
  const id = v7();
  const externalId = extra.external ?? v7();
  await db.query(
    `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at, updated_at)
     values ($1, 'p', $2, $3, repeat('a', 64), $4, $5, 'r', 'g', 'BET', '10.00', 'BRL', 'PROCESSED', now(), now(), now())`,
    [id, externalId, extra.key ?? `p:${externalId}`, walletId, playerId],
  );
  return id;
}

describe("wallets", () => {
  test("saldo negativo é barrado por CHECK", async () => {
    const { walletId } = await seedWallet();
    await expectError(`update wallets set balance = -0.01 where id = $1`, [walletId], "23514");
  });

  test("uma wallet por player + moeda", async () => {
    const { playerId } = await seedWallet();
    await expectError(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values ($1, $2, 'BRL', 0, 1, now(), now())`,
      [v7(), playerId],
      "23505",
      /uq_wallets_player_currency/,
    );
  });

  test("saldo não pode mudar sem lançamento correspondente (checado no commit)", async () => {
    const { walletId } = await seedWallet();
    await expectError(`update wallets set balance = balance + 1 where id = $1`, [walletId], "23514", /does not match ledger/);
  });
});

describe("ledger", () => {
  test("UPDATE, DELETE e TRUNCATE são bloqueados", async () => {
    const { walletId } = await seedWallet();
    await expectError(`update wallet_ledger_entries set amount = 1 where wallet_id = $1`, [walletId], "23001");
    await expectError(`delete from wallet_ledger_entries where wallet_id = $1`, [walletId], "23001");
    await expectError(`truncate wallet_ledger_entries`, [], "23001");
  });

  test("aritmética errada é barrada", async () => {
    const { walletId, playerId } = await seedWallet();
    const betId = await insertBet(walletId, playerId);
    await expectError(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (gen_random_uuid(), $1, $2, 'DEBIT', 10, 'BRL', 100, 95, now())`,
      [walletId, betId],
      "23514",
      /ck_ledger_arithmetic/,
    );
  });

  test("lançamento fora de sequência (balance_before != último balance_after) é barrado", async () => {
    const { walletId, playerId } = await seedWallet();
    const betId = await insertBet(walletId, playerId);
    await expectError(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (gen_random_uuid(), $1, $2, 'DEBIT', 10, 'BRL', 50, 40, now())`,
      [walletId, betId],
      "23514",
      /ledger chain broken/,
    );
  });

  test("um lançamento por transação/wallet", async () => {
    const { walletId, openingTxId } = await seedWallet();
    await expectError(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (gen_random_uuid(), $1, $2, 'CREDIT', 1, 'BRL', 100, 101, now())`,
      [walletId, openingTxId],
      "23505",
      /uq_ledger_transaction_wallet/,
    );
  });

  test("moeda do lançamento tem que ser a da wallet", async () => {
    const { walletId, playerId } = await seedWallet();
    const betId = await insertBet(walletId, playerId);
    await expectError(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (gen_random_uuid(), $1, $2, 'DEBIT', 10, 'USD', 100, 90, now())`,
      [walletId, betId],
      "23503",
      /fk_ledger_wallet_currency/,
    );
  });
});

describe("wager_transactions", () => {
  test("idempotency key e externalTransactionId são únicos por provider", async () => {
    const { walletId, playerId } = await seedWallet();
    await insertBet(walletId, playerId, { external: "dup-ext", key: "k1" });
    await expectError(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at, updated_at)
       values ($1, 'p', 'other-ext', 'k1', repeat('a', 64), $2, $3, 'r', 'g', 'BET', 1, 'BRL', 'PROCESSED', now(), now(), now())`,
      [v7(), walletId, playerId],
      "23505",
      /uq_wager_tx_idempotency/,
    );
    await expectError(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at, updated_at)
       values ($1, 'p', 'dup-ext', 'k2', repeat('a', 64), $2, $3, 'r', 'g', 'BET', 1, 'BRL', 'PROCESSED', now(), now(), now())`,
      [v7(), walletId, playerId],
      "23505",
      /uq_wager_tx_external/,
    );
  });

  test("referência só pode ter uma reversão processada (REFUND ou ROLLBACK)", async () => {
    const { walletId, playerId } = await seedWallet();
    const betId = await insertBet(walletId, playerId, { external: `bet-${v7()}` });
    const reversal = (kind: string) =>
      db.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
           reference_transaction_id, status, created_at, processed_at, updated_at)
         values ($1, 'p', $2, $2, repeat('a', 64), $3, $4, 'r', 'g', $5, 10, 'BRL', 'x', $6, 'PROCESSED', now(), now(), now())`,
        [v7(), v7(), walletId, playerId, kind, betId],
      );
    await reversal("REFUND");
    await expectError(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, created_at, processed_at, updated_at)
       values ($1::uuid, 'p', $1::text, $1::text, repeat('a', 64), $2, $3, 'r', 'g', 'ROLLBACK', 10, 'BRL', 'x', $4, 'PROCESSED', now(), now(), now())`,
      [v7(), walletId, playerId, betId],
      "23505",
      /uq_wager_tx_single_reversal/,
    );
  });

  test("REJECTED exige failure_code; REFUND exige referência; OPENING só interno", async () => {
    const { walletId, playerId } = await seedWallet();
    const base = `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code, created_at, processed_at, updated_at)
       values ($1::uuid, $4, $1::text, $1::text, repeat('a', 64), $2, $3, 'r', 'g', $5, 1, 'BRL', $6, $7, now(), now(), now())`;
    await expectError(base, [v7(), walletId, playerId, "p", "BET", "REJECTED", null], "23514", /ck_wager_tx_failure_code/);
    await expectError(base, [v7(), walletId, playerId, "p", "REFUND", "PROCESSED", null], "23514", /ck_wager_tx_reversal_reference/);
    await expectError(base, [v7(), walletId, playerId, "p", "OPENING", "PROCESSED", null], "23514", /ck_wager_tx_opening_internal/);
  });

  test("transação terminal não muda e nenhuma é apagada", async () => {
    const { walletId, playerId } = await seedWallet();
    const betId = await insertBet(walletId, playerId);
    await expectError(
      `update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = $1`,
      [betId],
      "23001",
      /terminal/,
    );
    await expectError(`delete from wager_transactions where id = $1`, [betId], "23001");
  });
});
