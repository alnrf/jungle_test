import type { InboxMessage } from "../messaging/domain/inbox-message";
import type { OutboxMessage } from "../messaging/domain/outbox-message";
import type { Money } from "../shared/domain/money";
import type { WalletLedgerEntry } from "../wallet/domain/ledger-entry";
import type { Wallet } from "../wallet/domain/wallet";
import type { WagerTransaction } from "../wagering/domain/wager-transaction";

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE. Toda escrita que envolve a wallet passa por aqui antes. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** UPDATE condicionado à versão anterior. Lança ConcurrencyConflictError se não bater. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Transações em PENDING_REFERENCE esperando (providerId, externalTransactionId) nessa wallet. */
  findWaitingFor(providerId: string, externalTransactionId: string, walletId: string): Promise<WagerTransaction[]>;
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  hasMore: boolean;
}

export interface ReconciliationSnapshot {
  stored: Money;
  calculated: Money;
  lastBalanceAfter: Money | undefined;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage>;
  reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface InboxRepository {
  /** false se a mensagem já estava registrada (redelivery). */
  tryInsert(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface OutboxRepository {
  add(messages: OutboxMessage[]): Promise<void>;
  /** FOR UPDATE SKIP LOCKED: publishers concorrentes pegam lotes disjuntos. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  /** Um UPDATE só pra todos os publicados do lote. */
  markPublished(ids: string[], at: Date): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface RunOptions {
  /**
   * Unique violations nessas constraints fazem a transação inteira rodar de
   * novo. Usado na idempotência: quem perdeu a corrida roda de novo e cai no replay.
   */
  retryOnUniqueConstraints?: string[];
}

export abstract class UnitOfWork {
  /** Executa `work` em uma transação. Retenta deadlock/serialização/lock timeout. */
  abstract run<T>(work: (repos: Repositories) => Promise<T>, options?: RunOptions): Promise<T>;
  /** Leitura sem transação explícita. */
  abstract read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
