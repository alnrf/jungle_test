import { InsufficientFundsError } from "../../shared/domain/errors";
import type { WalletLedgerEntry } from "../../wallet/domain/ledger-entry";
import type { Wallet } from "../../wallet/domain/wallet";
import { FailureCode } from "./failure-code";
import { WagerTransaction, WagerTransactionStatus } from "./wager-transaction";

export type SettlementOutcome =
  | { type: "processed"; entry?: WalletLedgerEntry }
  | { type: "rejected"; code: FailureCode }
  | { type: "waiting_reference" };

export interface SettlementContext {
  /** Transação resolvida por (providerId, referenceExternalTransactionId), se existir. */
  reference?: WagerTransaction;
  /** A referência já tem um REFUND/ROLLBACK processado? */
  referenceAlreadyReversed: boolean;
  now: Date;
}

/**
 * Aplica as regras de BET/WIN/LOSS/REFUND/ROLLBACK sobre a wallet.
 *
 * Quem chama precisa estar segurando o lock da wallet. Em "processed" e
 * "rejected" a transação já sai com o status final. Em "waiting_reference"
 * nada muda: quem chama decide se agenda nova tentativa ou desiste
 * (a política de retry não é regra de domínio).
 */
export function settleWager(tx: WagerTransaction, wallet: Wallet, ctx: SettlementContext): SettlementOutcome {
  const reject = (code: FailureCode): SettlementOutcome => {
    tx.reject(code, ctx.now, wallet.balance);
    return { type: "rejected", code };
  };

  if (!tx.money.hasCurrency(wallet.currency)) return reject(FailureCode.CurrencyMismatch);
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);

  const reference = ctx.reference;
  if (tx.referenceExternalTransactionId) {
    if (!reference || reference.status === WagerTransactionStatus.PendingReference) {
      // a referência ainda não chegou (ou chegou mas também está esperando a dela)
      return { type: "waiting_reference" };
    }
    const problem = checkReference(tx, reference, ctx.referenceAlreadyReversed);
    if (problem) return reject(problem);
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, ctx.now, wallet.balance);
    return { type: "processed" };
  }

  const direction = tx.ledgerDirectionFor(reference);
  let entry: WalletLedgerEntry;
  try {
    entry = wallet.apply(direction, tx.id, tx.money, ctx.now);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // aposta sem saldo é rotina; reversão que deixaria saldo negativo
      // é sinal de problema (ex.: rollback de WIN já gasto) e merece outro código
      return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
    }
    throw err;
  }

  tx.markProcessed(reference?.id, ctx.now, wallet.balance);
  return { type: "processed", entry };
}

function checkReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  if (!tx.canReference(reference.kind)) return FailureCode.ReferenceKindNotAllowed;

  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.roundId === tx.roundId &&
    reference.money.currency === tx.money.currency;
  if (!sameContext) return FailureCode.ReferenceMismatch;

  if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

  if (tx.isReversal()) {
    if (!reference.money.equals(tx.money)) return FailureCode.ReversalAmountMismatch;
    if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}

