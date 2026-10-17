import { createHash } from "node:crypto";
import type { MoneyProps } from "../../shared/domain/money";

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * JSON com chaves ordenadas recursivamente, sem espaços e sem campos undefined.
 * Arrays mantêm a ordem.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * sha256 (hex) do JSON canônico dos campos de negócio.
 * O amount precisa chegar normalizado ("25.00", não "25"). Quem chama já
 * passou pelo Money, então "25" e "25.00" geram o mesmo hash.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  const subset: WagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(subset)).digest("hex");
}
