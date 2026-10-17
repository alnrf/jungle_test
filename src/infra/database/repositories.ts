import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError } from "../../application/errors";
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  ReconciliationSnapshot,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "../../wallet/domain/ledger-entry";
import { Wallet } from "../../wallet/domain/wallet";
import type { FailureCode } from "../../wagering/domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../wagering/domain/wager-transaction";
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
  type InboxMessageRow,
  type LedgerEntryRow,
  type OutboxMessageRow,
  type WagerTransactionRow,
  type WalletRow,
} from "./schemas";

/*
 * Nota sobre o uso do MikroORM aqui: as leituras usam QueryBuilder com
 * execute(..., mapResults) e voltam como objeto simples, fora do Identity Map.
 * As escritas são insert/nativeUpdate explícitos.
 *
 * Motivo: no caminho financeiro eu quero saber exatamente qual SQL roda e em
 * que ordem (ex.: o UPDATE da wallet com "where version = ?"). Com flush do
 * Unit of Work e entidades gerenciadas isso fica implícito, e reler uma linha
 * depois de um nativeUpdate devolveria a versão em cache.
 */

const optional = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

// ---------------------------------------------------------------- wallets

const toWallet = (row: WalletRow): Wallet =>
  Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.fromPersistence(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em
      .createQueryBuilder(WalletSchema)
      .select("*")
      .where({ id })
      .execute<WalletRow | undefined>("get");
    return row ? toWallet(row) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const row = await this.em
      .createQueryBuilder(WalletSchema)
      .select("*")
      .where({ id })
      .setLockMode(LockMode.PESSIMISTIC_WRITE)
      .execute<WalletRow | undefined>("get");
    return row ? toWallet(row) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`wallet ${wallet.id} changed (expected version ${expectedVersion})`);
    }
  }
}

// ---------------------------------------------------------------- transactions

const toTransaction = (row: WagerTransactionRow): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.fromPersistence(row.amount, row.currency),
    referenceExternalTransactionId: optional(row.referenceExternalTransactionId),
    referenceTransactionId: optional(row.referenceTransactionId),
    status: row.status as WagerTransactionStatus,
    failureCode: optional(row.failureCode) as FailureCode | undefined,
    observedBalance:
      row.observedBalance === null ? undefined : Money.fromPersistence(row.observedBalance, row.currency),
    referenceAttempts: row.referenceAttempts,
    nextReferenceCheckAt: optional(row.nextReferenceCheckAt),
    createdAt: row.createdAt,
    processedAt: optional(row.processedAt),
  });

const mutableColumns = (tx: WagerTransaction) => ({
  status: tx.status,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  failureCode: tx.failureCode ?? null,
  observedBalance: tx.observedBalance?.amount ?? null,
  referenceAttempts: tx.referenceAttempts,
  nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
  processedAt: tx.processedAt ?? null,
});

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      createdAt: tx.createdAt,
      updatedAt: tx.processedAt ?? tx.createdAt,
      ...mutableColumns(tx),
    });
  }

  async update(tx: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id },
      { ...mutableColumns(tx), updatedAt: new Date() },
    );
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findWaitingFor(
    providerId: string,
    externalTransactionId: string,
    walletId: string,
  ): Promise<WagerTransaction[]> {
    const rows = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .select("*")
      .where({
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        walletId,
        status: WagerTransactionStatus.PendingReference,
      })
      .orderBy({ createdAt: "asc" })
      .execute<WagerTransactionRow[]>("all");
    return rows.map(toTransaction);
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    return this.em
      .createQueryBuilder(WagerTransactionSchema)
      .select(["id", "walletId"])
      .where({ status: WagerTransactionStatus.PendingReference, nextReferenceCheckAt: { $lte: now } })
      .orderBy({ nextReferenceCheckAt: "asc" })
      .limit(limit)
      .execute<Array<{ id: string; walletId: string }>>("all");
  }

  private async findOne(where: Partial<WagerTransactionRow>): Promise<WagerTransaction | undefined> {
    const row = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .select("*")
      .where(where)
      .execute<WagerTransactionRow | undefined>("get");
    return row ? toTransaction(row) : undefined;
  }
}

// ---------------------------------------------------------------- ledger

const toLedgerEntry = (row: LedgerEntryRow): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: row.id,
    sequence: String(row.seq),
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: Money.fromPersistence(row.amount, row.currency),
    balanceBefore: Money.fromPersistence(row.balanceBefore, row.currency),
    balanceAfter: Money.fromPersistence(row.balanceAfter, row.currency),
    createdAt: row.createdAt,
  });

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt,
    });
  }

  async page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage> {
    const qb = this.em
      .createQueryBuilder(LedgerEntrySchema)
      .select("*")
      .where({ walletId })
      .orderBy({ seq: "asc" })
      .limit(limit + 1);
    if (afterSequence) qb.andWhere({ seq: { $gt: afterSequence } });

    const rows = await qb.execute<LedgerEntryRow[]>("all");
    return {
      entries: rows.slice(0, limit).map(toLedgerEntry),
      hasMore: rows.length > limit,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // um único SELECT: wallet e soma do ledger vêm do mesmo snapshot
    const row = await this.em.execute<
      Array<{ stored: string; currency: string; calculated: string; entries: number; last_after: string | null }>
    >(
      `select w.balance as stored,
              w.currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20, 2)
                as calculated,
              count(l.id)::int as entries,
              (select l2.balance_after
                 from wallet_ledger_entries l2
                where l2.wallet_id = w.id
                order by l2.seq desc
                limit 1) as last_after
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
      "all",
    );
    const r = row[0];
    if (!r) return undefined;
    return {
      stored: Money.fromPersistence(String(r.stored), r.currency),
      calculated: Money.fromPersistence(String(r.calculated), r.currency),
      lastBalanceAfter: r.last_after === null ? undefined : Money.fromPersistence(String(r.last_after), r.currency),
      entries: Number(r.entries),
    };
  }
}

// ---------------------------------------------------------------- inbox

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    // ON CONFLICT DO NOTHING: se outra instância estiver inserindo a mesma
    // mensagem agora, o postgres espera ela terminar antes de responder
    const rows = await this.em.execute<Array<{ message_id: string }>>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
      "all",
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .select("*")
      .where({ consumerName, messageId })
      .execute<InboxMessageRow | undefined>("get");
    if (!row) return undefined;
    return InboxMessage.rehydrate({ ...row, processedAt: optional(row.processedAt) });
  }
}

// ---------------------------------------------------------------- outbox

const toOutbox = (row: OutboxMessageRow): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: optional(row.nextAttemptAt),
    publishedAt: optional(row.publishedAt),
    lastError: optional(row.lastError),
  });

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxMessageSchema,
      messages.map((m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: m.payload as Record<string, unknown>,
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt ?? null,
        publishedAt: null,
        lastError: null,
      })),
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em
      .createQueryBuilder(OutboxMessageSchema)
      .select("*")
      .where({ publishedAt: null, nextAttemptAt: { $lte: now } })
      .orderBy({ occurredAt: "asc" })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE) // FOR UPDATE SKIP LOCKED
      .execute<OutboxMessageRow[]>("all");
    return rows.map(toOutbox);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
  }

  async markPublished(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.em.nativeUpdate(OutboxMessageSchema, { id: { $in: ids } }, { publishedAt: at, nextAttemptAt: null });
  }

  async stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await this.em.execute<Array<{ pending: number; oldest: Date | null }>>(
      `select count(*)::int as pending, min(occurred_at) as oldest
         from outbox_messages
        where published_at is null`,
      [],
      "all",
    );
    const r = rows[0];
    const oldest = r?.oldest ? new Date(r.oldest) : undefined;
    return {
      pending: Number(r?.pending ?? 0),
      oldestAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }
}

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
