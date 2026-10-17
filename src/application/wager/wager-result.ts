import type { MoneyProps } from "../../shared/domain/money";
import type { WagerTransaction, WagerTransactionStatus } from "../../wagering/domain/wager-transaction";
import type { Money } from "../../shared/domain/money";

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

export const toWagerResult = (tx: WagerTransaction, balance: Money | undefined, replay: boolean): WagerResult => ({
  transactionId: tx.id,
  status: tx.status,
  balance: (tx.observedBalance ?? balance)?.toJSON(),
  ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  idempotentReplay: replay,
});
