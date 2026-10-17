import { Injectable } from "@nestjs/common";
import { AppLogger } from "../../infra/observability/logger";
import { Metrics } from "../../infra/observability/metrics";
import type { MoneyProps } from "../../shared/domain/money";
import { WalletNotFoundError } from "../errors";
import { UnitOfWork } from "../ports";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** o balance_after do último lançamento também bate com o saldo? */
  lastEntryMatches: boolean;
}

/**
 * Compara o saldo materializado com a soma do ledger. Só reporta: corrigir
 * divergência automaticamente esconderia o bug que causou a divergência.
 */
@Injectable()
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.uow.read((repos) => repos.ledger.reconcile(walletId));
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const difference = snapshot.stored.subtract(snapshot.calculated);
    const lastEntryMatches = snapshot.lastBalanceAfter
      ? snapshot.lastBalanceAfter.equals(snapshot.stored)
      : snapshot.stored.isZero();
    const consistent = difference.isZero() && lastEntryMatches;

    if (!consistent) {
      this.metrics.reconciliationDivergences.inc();
      // aqui o valor entra no log de propósito: é o que alguém vai precisar pra investigar
      this.logger.warning("wallet reconciliation divergence", {
        walletId,
        difference: difference.amount,
        checkedEntries: snapshot.entries,
        lastEntryMatches,
      });
    }

    return {
      walletId,
      storedBalance: snapshot.stored.toJSON(),
      calculatedBalance: snapshot.calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
      lastEntryMatches,
    };
  }
}
