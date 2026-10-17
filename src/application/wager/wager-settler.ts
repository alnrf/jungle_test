import { Injectable } from "@nestjs/common";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../messaging/domain/events";
import type { EventContext, IntegrationEvent } from "../../messaging/domain/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { Metrics } from "../../infra/observability/metrics";
import type { Wallet } from "../../wallet/domain/wallet";
import { FailureCode } from "../../wagering/domain/failure-code";
import { settleWager, type SettlementOutcome } from "../../wagering/domain/wager-settlement";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import type { Repositories } from "../ports";
import { ReferenceRetryPolicy } from "../reference-retry-policy";

export type SettleMode =
  /** transação nova, ainda não existe no banco */
  | "new"
  /** já está em PENDING_REFERENCE; veio do worker agendado */
  | "scheduled_retry"
  /** já está em PENDING_REFERENCE; a referência acabou de ser decidida na mesma transação SQL */
  | "reference_arrived";

/**
 * Decide, persiste e enfileira os eventos de uma transação.
 *
 * Pré-condição: a wallet foi carregada com lockById() dentro da transação
 * SQL atual. Toda mudança em wager_transactions acontece com o lock da wallet
 * dela, então não precisa de lock separado na linha da transação.
 */
@Injectable()
export class WagerSettler {
  constructor(
    private readonly retryPolicy: ReferenceRetryPolicy,
    private readonly metrics: Metrics,
  ) {}

  async settle(
    repos: Repositories,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
    mode: SettleMode,
  ): Promise<SettlementOutcome> {
    const now = ctx.occurredAt;
    const reference = tx.referenceExternalTransactionId
      ? await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference && tx.isReversal() ? await repos.transactions.hasProcessedReversal(reference.id) : false;

    const expectedVersion = wallet.version;
    let outcome = settleWager(tx, wallet, { reference, referenceAlreadyReversed, now });

    if (outcome.type === "waiting_reference") {
      if (mode === "scheduled_retry" && this.retryPolicy.shouldGiveUp(tx.referenceAttempts)) {
        tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
        outcome = { type: "rejected", code: FailureCode.ReferenceNotFound };
        this.metrics.pendingReferenceExpired.inc();
      } else {
        const attempts = mode === "new" ? 0 : tx.referenceAttempts + 1;
        tx.markPendingReference(this.retryPolicy.nextCheckAt(attempts, now));
      }
    }

    if (mode === "new") await repos.transactions.insert(tx);
    else await repos.transactions.update(tx);

    const events: IntegrationEvent<unknown>[] = [];
    if (outcome.type === "processed") {
      if (outcome.entry) {
        await repos.ledger.insert(outcome.entry);
        await repos.wallets.saveBalance(wallet, expectedVersion);
        events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx));
      }
      events.push(WagerTransactionProcessed.from(tx, wallet, ctx));
    } else if (outcome.type === "rejected") {
      events.push(WagerTransactionRejected.from(tx, ctx));
    } else if (mode === "new") {
      // só avisa na primeira vez; reagendamento não é novidade pra ninguém
      events.push(WagerTransactionPendingReference.from(tx, ctx));
    }
    await repos.outbox.add(events.map((e) => OutboxMessage.enqueue(e)));

    if (tx.isTerminal()) {
      this.metrics.transactions.inc({ kind: tx.kind, status: tx.status });
      await this.settleDependents(repos, tx, wallet, ctx);
    }
    return outcome;
  }

  /**
   * Quem estava esperando por essa transação (ex.: ROLLBACK que chegou antes
   * do BET) é decidido agora, na mesma transação SQL e com o mesmo lock.
   * Se a referência foi rejeitada, os dependentes também acabam rejeitados.
   */
  private async settleDependents(
    repos: Repositories,
    decided: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): Promise<void> {
    const waiting = await repos.transactions.findWaitingFor(
      decided.providerId,
      decided.externalTransactionId,
      wallet.id,
    );
    for (const dependent of waiting) {
      await this.settle(repos, dependent, wallet, { ...ctx, causationId: decided.id }, "reference_arrived");
    }
  }
}
