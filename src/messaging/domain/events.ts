import type { MoneyProps } from "../../shared/domain/money";
import type { LedgerDirection, WalletLedgerEntry } from "../../wallet/domain/ledger-entry";
import type { Wallet } from "../../wallet/domain/wallet";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from "./integration-event";

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

const transactionData = (tx: WagerTransaction): TransactionEventData => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  referenceExternalTransactionId: tx.referenceExternalTransactionId,
  referenceTransactionId: tx.referenceTransactionId,
});

export interface WagerTransactionProcessedData extends TransactionEventData {
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.props(
        tx.id,
        {
          ...transactionData(tx),
          balanceAfter: wallet.balance.toJSON(),
          processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
        },
        ctx,
      ),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error(`transaction ${tx.id} has no failure code`);
    return new WagerTransactionRejected(
      IntegrationEvent.props(tx.id, { ...transactionData(tx), failureCode: tx.failureCode }, ctx),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  nextCheckAt?: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(
        tx.id,
        { ...transactionData(tx), nextCheckAt: tx.nextReferenceCheckAt?.toISOString() },
        ctx,
      ),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }
}
