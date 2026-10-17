import { EntitySchema } from "@mikro-orm/core";

/*
 * Mapeamento das tabelas. São linhas "burras", sem regra nenhuma: o domínio
 * não conhece o ORM e a conversão acontece nos repositórios (rehydrate).
 *
 * Colunas numeric chegam como string, que é exatamente o que o Money espera.
 */

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: "Wallet",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    balance: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    version: { type: "integer" },
    createdAt: { type: "datetime", columnType: "timestamptz" },
    updatedAt: { type: "datetime", columnType: "timestamptz" },
  },
});

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  observedBalance: string | null;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
  updatedAt: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: "WagerTransaction",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    observedBalance: { type: "decimal", precision: 20, scale: 2, runtimeType: "string", nullable: true },
    referenceAttempts: { type: "integer" },
    nextReferenceCheckAt: { type: "datetime", columnType: "timestamptz", nullable: true },
    createdAt: { type: "datetime", columnType: "timestamptz" },
    processedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
    updatedAt: { type: "datetime", columnType: "timestamptz" },
  },
});

export interface LedgerEntryRow {
  seq?: string;
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  name: "WalletLedgerEntry",
  tableName: "wallet_ledger_entries",
  properties: {
    // gerada pelo banco (identity); nunca entra no insert
    seq: { type: "bigint", persist: false },
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    balanceAfter: { type: "decimal", precision: 20, scale: 2, runtimeType: "string" },
    createdAt: { type: "datetime", columnType: "timestamptz" },
  },
});

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  name: "InboxMessage",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string" },
    receivedAt: { type: "datetime", columnType: "timestamptz" },
    processedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
  },
});

export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  name: "OutboxMessage",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string" },
    payload: { type: "json" },
    occurredAt: { type: "datetime", columnType: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", columnType: "timestamptz", nullable: true },
    publishedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
    lastError: { type: "text", nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
