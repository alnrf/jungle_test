import { Injectable } from "@nestjs/common";
import type { MoneyProps } from "../../shared/domain/money";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { InvalidCursorError, NotFoundError, WalletNotFoundError } from "../errors";
import { UnitOfWork } from "../ports";
import { toWalletView, type WalletView } from "./create-wallet";

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balanceAfter?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

const toTransactionView = (tx: WagerTransaction): TransactionView => ({
  id: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  failureCode: tx.failureCode,
  referenceExternalTransactionId: tx.referenceExternalTransactionId,
  referenceTransactionId: tx.referenceTransactionId,
  balanceAfter: tx.observedBalance?.toJSON(),
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString(),
});

// cursor opaco: base64url de "v1:<seq>". O prefixo deixa trocar o formato depois.
const encodeCursor = (sequence: string) => Buffer.from(`v1:${sequence}`).toString("base64url");

function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (!match?.[1]) throw new InvalidCursorError("invalid cursor");
  return match[1];
}

@Injectable()
export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async wallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    return this.uow.read(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const page = await repos.ledger.page(walletId, after, limit);
      const last = page.entries[page.entries.length - 1];
      return {
        items: page.entries.map((e) => ({
          id: e.id,
          transactionId: e.transactionId,
          direction: e.direction,
          money: e.money.toJSON(),
          balanceBefore: e.balanceBefore.toJSON(),
          balanceAfter: e.balanceAfter.toJSON(),
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: page.hasMore && last?.sequence ? encodeCursor(last.sequence) : null,
      };
    });
  }

  async transaction(transactionId: string): Promise<TransactionView> {
    const tx = await this.uow.read((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError(`transaction ${transactionId} not found`);
    return toTransactionView(tx);
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.uow.read((repos) => repos.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
    return toTransactionView(tx);
  }
}
