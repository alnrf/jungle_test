import { v7 } from "uuid";

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export class Api {
  constructor(readonly baseUrl: string) {}

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  async createWallet(amount = "100.00", currency = "BRL") {
    const playerId = v7();
    const res = await this.request<{ id: string; playerId: string }>("POST", "/wallets", {
      playerId,
      initialBalance: { amount, currency },
    });
    if (res.status !== 201) throw new Error(`createWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { walletId: res.body.id, playerId };
  }

  submit(body: WagerBody, idempotencyKey = `${body.providerId}:${body.externalTransactionId}`) {
    return this.request<{
      transactionId: string;
      status: string;
      balance?: { amount: string };
      failureCode?: string;
      idempotentReplay: boolean;
    }>("POST", "/wagering/transactions", body, { "Idempotency-Key": idempotencyKey });
  }
}

let seq = 0;
export const uniqueId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function wagerBody(
  wallet: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Partial<WagerBody> = {},
): WagerBody {
  return {
    providerId: "provider-test",
    externalTransactionId: uniqueId(kind.toLowerCase()),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
}
