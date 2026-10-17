import { Injectable } from "@nestjs/common";
import { describeError, AppLogger } from "../../infra/observability/logger";
import { logContext } from "../../infra/observability/log-context";
import { Clock } from "../../shared/domain/clock";
import { newId } from "../../shared/domain/ids";
import { FailureCode } from "../../wagering/domain/failure-code";
import { WagerTransactionStatus } from "../../wagering/domain/wager-transaction";
import { WagerTransactionRejected } from "../../messaging/domain/events";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { TransientInfrastructureError } from "../errors";
import { UnitOfWork } from "../ports";
import { WagerSettler } from "./wager-settler";

/**
 * Reprocessa transações em PENDING_REFERENCE cujo próximo check venceu.
 *
 * Várias instâncias podem rodar isso ao mesmo tempo sem problema: cada
 * candidato é tratado com o lock da wallet e o status é relido depois do
 * lock. Quem chegar depois encontra a transação já decidida (ou reagendada
 * pro futuro) e pula.
 */
@Injectable()
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settler: WagerSettler,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  /** Retorna quantas transações foram efetivamente reavaliadas. */
  async runOnce(batchSize = 20): Promise<number> {
    const due = await this.uow.read((repos) => repos.transactions.findDuePendingReferences(this.clock.now(), batchSize));
    let handled = 0;
    for (const candidate of due) {
      const correlationId = newId();
      await logContext.run({ correlationId, transactionId: candidate.id, walletId: candidate.walletId }, async () => {
        try {
          if (await this.resolve(candidate.id, candidate.walletId, correlationId)) handled++;
        } catch (err) {
          if (err instanceof TransientInfrastructureError) {
            // fica pra próxima volta do worker
            this.logger.warning("pending reference check postponed", describeError(err));
            return;
          }
          this.logger.failure("pending reference check crashed", err);
          await this.markFailed(candidate.id, candidate.walletId, correlationId);
        }
      });
    }
    return handled;
  }

  private resolve(transactionId: string, walletId: string, correlationId: string): Promise<boolean> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.lockById(walletId);
      const tx = await repos.transactions.findById(transactionId);
      const now = this.clock.now();
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return false;
      if (tx.nextReferenceCheckAt && tx.nextReferenceCheckAt > now) return false;

      const outcome = await this.settler.settle(
        repos,
        tx,
        wallet,
        { correlationId, causationId: tx.id, occurredAt: now },
        "scheduled_retry",
      );
      this.logger.info("pending reference checked", { outcome: outcome.type, attempts: tx.referenceAttempts });
      return true;
    });
  }

  /** Erro inesperado (bug, dado corrompido): para de tentar e deixa auditável. */
  private async markFailed(transactionId: string, walletId: string, correlationId: string): Promise<void> {
    try {
      await this.uow.run(async (repos) => {
        await repos.wallets.lockById(walletId);
        const tx = await repos.transactions.findById(transactionId);
        if (!tx || tx.isTerminal()) return;
        const now = this.clock.now();
        tx.fail(FailureCode.ProcessingError, now);
        await repos.transactions.update(tx);
        await repos.outbox.add([
          OutboxMessage.enqueue(WagerTransactionRejected.from(tx, { correlationId, causationId: tx.id, occurredAt: now })),
        ]);
      });
    } catch (err) {
      this.logger.failure("could not mark transaction as failed", err);
    }
  }
}
