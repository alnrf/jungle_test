import { Injectable } from "@nestjs/common";
import { Metrics } from "../../infra/observability/metrics";
import { logContext } from "../../infra/observability/log-context";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import type { EventContext } from "../../messaging/domain/integration-event";
import { Clock } from "../../shared/domain/clock";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { wagerPayloadHash } from "../../wagering/domain/payload-hash";
import { WagerTransaction, WagerTransactionKind } from "../../wagering/domain/wager-transaction";
import { IdempotencyConflictError, WalletNotFoundError } from "../errors";
import { UnitOfWork, type Repositories } from "../ports";
import { WagerSettler } from "./wager-settler";
import { toWagerResult, type WagerResult } from "./wager-result";

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export type WagerSource =
  | { type: "http"; correlationId: string }
  | { type: "sqs"; correlationId: string; consumerName: string; messageId: string };

// constraints que indicam "outra request com a mesma chave ganhou a corrida"
const IDEMPOTENCY_CONSTRAINTS = ["uq_wager_tx_idempotency", "uq_wager_tx_external"];

/**
 * Entrada única para HTTP e SQS.
 *
 * Tudo numa transação SQL só: inbox (se SQS), transação, ledger, saldo e
 * outbox. Ou entra tudo ou nada.
 */
@Injectable()
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settler: WagerSettler,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  async execute(cmd: SubmitWagerCommand, source: WagerSource): Promise<WagerResult> {
    const startedAt = performance.now();
    let outcome = "error";
    try {
      const result = await this.process(cmd, source);
      outcome = result.idempotentReplay ? "replay" : result.status.toLowerCase();
      return result;
    } finally {
      this.metrics.processingDuration.observe(
        { source: source.type, outcome },
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  private async process(cmd: SubmitWagerCommand, source: WagerSource): Promise<WagerResult> {
    const money = Money.from(cmd.money);
    const payloadHash = wagerPayloadHash({ ...cmd, money: money.toJSON() });
    logContext.assign({ providerId: cmd.providerId, walletId: cmd.walletId });

    return this.uow.run(
      async (repos) => {
        const now = this.clock.now();

        if (source.type === "sqs") {
          const inbox = InboxMessage.receive({
            consumerName: source.consumerName,
            messageId: source.messageId,
            payloadHash,
            receivedAt: now,
          });
          inbox.markProcessed(now);
          if (!(await repos.inbox.tryInsert(inbox))) {
            return this.redelivered(repos, cmd, payloadHash, source);
          }
        }

        // caminho rápido: replay sem precisar do lock da wallet
        const known = await this.findReplay(repos, cmd, payloadHash, source);
        if (known) return known;

        const wallet = await repos.wallets.lockById(cmd.walletId);
        if (!wallet) throw new WalletNotFoundError(cmd.walletId);

        // alguém pode ter processado a mesma chave enquanto esperávamos o lock
        const raced = await this.findReplay(repos, cmd, payloadHash, source);
        if (raced) return raced;

        const tx = WagerTransaction.create({
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash,
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: cmd.kind,
          money,
          referenceExternalTransactionId: cmd.referenceExternalTransactionId,
          createdAt: now,
        });
        logContext.assign({ transactionId: tx.id });

        const ctx: EventContext = {
          correlationId: source.correlationId,
          causationId: source.type === "sqs" ? source.messageId : cmd.idempotencyKey,
          occurredAt: now,
        };
        await this.settler.settle(repos, tx, wallet, ctx, "new");
        return toWagerResult(tx, wallet.balance, false);
      },
      { retryOnUniqueConstraints: IDEMPOTENCY_CONSTRAINTS },
    );
  }

  private async findReplay(
    repos: Repositories,
    cmd: SubmitWagerCommand,
    payloadHash: string,
    source: WagerSource,
  ): Promise<WagerResult | undefined> {
    const existing =
      (await repos.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey)) ??
      (await repos.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId));
    if (!existing) return undefined;

    if (existing.idempotencyKey !== cmd.idempotencyKey) {
      this.metrics.idempotencyConflicts.inc({ source: source.type });
      throw new IdempotencyConflictError(
        `externalTransactionId ${cmd.externalTransactionId} was already used with another idempotency key`,
      );
    }
    if (!existing.matchesPayload(payloadHash)) {
      this.metrics.idempotencyConflicts.inc({ source: source.type });
      throw new IdempotencyConflictError("idempotency key reused with a different payload");
    }

    this.metrics.duplicates.inc({ source: source.type, layer: "idempotency_key" });
    logContext.assign({ transactionId: existing.id });

    // PENDING_REFERENCE ainda não tem saldo "observado"; devolve o atual
    const balance = existing.observedBalance ?? (await repos.wallets.findById(existing.walletId))?.balance;
    return toWagerResult(existing, balance, true);
  }

  private async redelivered(
    repos: Repositories,
    cmd: SubmitWagerCommand,
    payloadHash: string,
    source: Extract<WagerSource, { type: "sqs" }>,
  ): Promise<WagerResult> {
    this.metrics.duplicates.inc({ source: source.type, layer: "inbox" });
    const inbox = await repos.inbox.find(source.consumerName, source.messageId);
    if (inbox && inbox.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(`messageId ${source.messageId} reused with a different payload`);
    }
    const replay = await this.findReplay(repos, cmd, payloadHash, source);
    if (replay) return replay;
    // inbox e transação são gravadas no mesmo commit, então isso não deveria acontecer
    throw new Error(`inbox has message ${source.messageId} but no matching transaction`);
  }
}
