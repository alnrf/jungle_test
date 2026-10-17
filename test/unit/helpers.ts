import { Money } from "../../src/shared/domain/money";
import { Wallet } from "../../src/wallet/domain/wallet";
import { wagerPayloadHash } from "../../src/wagering/domain/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from "../../src/wagering/domain/wager-transaction";

export const NOW = new Date("2026-10-12T12:00:00Z");
export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

export const wallet = (amount = "100.00") =>
  Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl(amount), now: NOW });

export function wager(
  kind: WagerTransactionKind,
  overrides: Partial<Omit<CreateWagerTransactionProps, "kind">> & { amount?: string } = {},
): WagerTransaction {
  const { amount = "10.00", ...rest } = overrides;
  const props = {
    providerId: "provider-a",
    externalTransactionId: `ext-${kind}-${Math.random().toString(36).slice(2)}`,
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    money: brl(amount),
    createdAt: NOW,
    ...rest,
  };
  return WagerTransaction.create({
    ...props,
    kind,
    idempotencyKey: props.idempotencyKey ?? `${props.providerId}:${props.externalTransactionId}`,
    payloadHash:
      props.payloadHash ??
      wagerPayloadHash({ ...props, kind, money: props.money.toJSON() }),
  });
}

export { WagerTransactionKind };
