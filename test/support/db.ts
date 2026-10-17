import { expect } from "bun:test";
import pg from "pg";
import { BASE_ENV } from "./env";

/** Conexão direta pro banco, só pra verificar estado nos testes. */
export class TestDb {
  private readonly pool = new pg.Pool({ connectionString: BASE_ENV.DATABASE_URL, max: 4 });

  async query<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  async one<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.query<T>(sql, params);
    if (!rows[0]) throw new Error(`no rows for: ${sql}`);
    return rows[0];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * A invariante que vale pra todos os testes:
   *   wallet.balance == saldo reconstruído pelo ledger
   * e mais: o último balance_after bate, e nada é negativo.
   */
  async expectWalletConsistent(walletId: string): Promise<{ balance: string; entries: number }> {
    const row = await this.one<{
      balance: string;
      calculated: string;
      last_after: string | null;
      entries: number;
      negative: number;
    }>(
      `select w.balance,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2) as calculated,
              (select balance_after from wallet_ledger_entries where wallet_id = w.id order by seq desc limit 1) as last_after,
              count(l.id)::int as entries,
              count(*) filter (where l.balance_after < 0)::int as negative
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = $1
        group by w.id`,
      [walletId],
    );
    expect(row.calculated).toBe(row.balance);
    expect(row.last_after ?? "0.00").toBe(row.balance);
    expect(row.negative).toBe(0);
    expect(Number(row.balance)).toBeGreaterThanOrEqual(0);
    return { balance: row.balance, entries: row.entries };
  }

  async ledgerCount(walletId: string, direction?: "DEBIT" | "CREDIT"): Promise<number> {
    const row = await this.one<{ n: number }>(
      `select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and ($2::text is null or direction = $2)`,
      [walletId, direction ?? null],
    );
    return row.n;
  }

  async transactionsByExternalId(providerId: string, externalId: string) {
    return this.query<{ id: string; status: string; failure_code: string | null }>(
      `select id, status, failure_code from wager_transactions where provider_id = $1 and external_transaction_id = $2`,
      [providerId, externalId],
    );
  }

  async balance(walletId: string): Promise<string> {
    return (await this.one<{ balance: string }>(`select balance from wallets where id = $1`, [walletId])).balance;
  }
}
