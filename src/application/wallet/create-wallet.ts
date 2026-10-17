import { Injectable } from "@nestjs/common";
import { Metrics } from "../../infra/observability/metrics";
import { WagerTransactionProcessed, WalletBalanceChanged } from "../../messaging/domain/events";
import type { EventContext, IntegrationEvent } from "../../messaging/domain/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { Clock } from "../../shared/domain/clock";
import { newId } from "../../shared/domain/ids";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { Wallet } from "../../wallet/domain/wallet";
import { wagerPayloadHash } from "../../wagering/domain/payload-hash";
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
} from "../../wagering/domain/wager-transaction";
import { UniqueViolationError, WalletAlreadyExistsError } from "../errors";
import { UnitOfWork } from "../ports";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

@Injectable()
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  async execute(cmd: CreateWalletCommand, correlationId: string): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);

    try {
      return await this.uow.run(async (repos) => {
        const now = this.clock.now();
        const wallet = Wallet.open({ id: newId(), playerId: cmd.playerId, initialBalance, now });
        await repos.wallets.insert(wallet);

        if (initialBalance.isPositive()) {
          // saldo inicial também passa pelo ledger, como qualquer outro crédito
          const opening = WagerTransaction.create({
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            payloadHash: wagerPayloadHash({
              providerId: INTERNAL_PROVIDER_ID,
              externalTransactionId: `opening:${wallet.id}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: "opening",
              gameId: "internal",
              kind: WagerTransactionKind.Opening,
              money: initialBalance.toJSON(),
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: "opening",
            gameId: "internal",
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: now,
          });
          opening.markProcessed(undefined, now, wallet.balance);
          const entry = wallet.openingEntry(opening.id);

          await repos.transactions.insert(opening);
          if (entry) await repos.ledger.insert(entry);

          const ctx: EventContext = { correlationId, causationId: wallet.id, occurredAt: now };
          const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(opening, wallet, ctx)];
          if (entry) events.push(WalletBalanceChanged.from(wallet, entry, ctx));
          await repos.outbox.add(events.map((e) => OutboxMessage.enqueue(e)));
          this.metrics.transactions.inc({ kind: opening.kind, status: opening.status });
        }

        return toWalletView(wallet);
      });
    } catch (err) {
      if (err instanceof UniqueViolationError && err.constraint === "uq_wallets_player_currency") {
        throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);
      }
      throw err;
    }
  }
}
