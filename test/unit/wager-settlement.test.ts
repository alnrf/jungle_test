import { describe, expect, test } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import { LedgerDirection } from "../../src/wallet/domain/ledger-entry";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { settleWager, type SettlementContext } from "../../src/wagering/domain/wager-settlement";
import { WagerTransactionStatus, type WagerTransaction } from "../../src/wagering/domain/wager-transaction";
import { NOW, wager, wallet, WagerTransactionKind as K } from "./helpers";

const ctx = (overrides: Partial<SettlementContext> = {}): SettlementContext => ({
  referenceAlreadyReversed: false,
  now: NOW,
  ...overrides,
});

/** Liquida a transação numa wallet e devolve a referência já PROCESSED. */
function processed(tx: WagerTransaction, w = wallet()) {
  const outcome = settleWager(tx, w, ctx());
  expect(outcome.type).toBe("processed");
  return tx;
}

describe("BET", () => {
  test("debita e gera um lançamento DEBIT", () => {
    const w = wallet();
    const bet = wager(K.Bet, { amount: "25.00" });
    const outcome = settleWager(bet, w, ctx());

    expect(outcome.type).toBe("processed");
    if (outcome.type !== "processed") return;
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe("75.00");
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.observedBalance?.amount).toBe("75.00");
  });

  test("sem saldo: REJECTED com INSUFFICIENT_FUNDS e saldo intacto", () => {
    const w = wallet("50.00");
    const bet = wager(K.Bet, { amount: "80.00" });
    const outcome = settleWager(bet, w, ctx());

    expect(outcome).toEqual({ type: "rejected", code: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    expect(w.balance.amount).toBe("50.00");
    expect(w.version).toBe(1);
  });

  test("cenário das duas apostas de 80 com saldo 100", () => {
    const w = wallet("100.00");
    const first = settleWager(wager(K.Bet, { amount: "80.00" }), w, ctx());
    const second = settleWager(wager(K.Bet, { amount: "80.00" }), w, ctx());
    expect(first.type).toBe("processed");
    expect(second).toEqual({ type: "rejected", code: FailureCode.InsufficientFunds });
    expect(w.balance.amount).toBe("20.00");
  });

  test("moeda diferente da wallet: CURRENCY_MISMATCH", () => {
    const w = wallet();
    const bet = wager(K.Bet, { money: Money.from({ amount: "10.00", currency: "USD" }) });
    expect(settleWager(bet, w, ctx())).toEqual({ type: "rejected", code: FailureCode.CurrencyMismatch });
    expect(w.balance.amount).toBe("100.00");
  });

  test("player diferente do dono da wallet: WALLET_PLAYER_MISMATCH", () => {
    const bet = wager(K.Bet, { playerId: "player-2" });
    expect(settleWager(bet, wallet(), ctx())).toEqual({
      type: "rejected",
      code: FailureCode.WalletPlayerMismatch,
    });
  });
});

describe("WIN", () => {
  test("credita", () => {
    const w = wallet();
    const outcome = settleWager(wager(K.Win, { amount: "50.00" }), w, ctx());
    expect(outcome.type).toBe("processed");
    expect(w.balance.amount).toBe("150.00");
  });

  test("pode referenciar o BET da rodada", () => {
    const bet = processed(wager(K.Bet, { externalTransactionId: "bet-1" }));
    const win = wager(K.Win, { referenceExternalTransactionId: "bet-1", amount: "30.00" });
    const outcome = settleWager(win, wallet(), ctx({ reference: bet }));
    expect(outcome.type).toBe("processed");
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("referência de outra rodada: REFERENCE_MISMATCH", () => {
    const bet = processed(wager(K.Bet, { externalTransactionId: "bet-1", roundId: "round-x" }));
    const win = wager(K.Win, { referenceExternalTransactionId: "bet-1" });
    expect(settleWager(win, wallet(), ctx({ reference: bet }))).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceMismatch,
    });
  });
});

describe("LOSS", () => {
  test("processa sem mexer no saldo e sem lançamento", () => {
    const w = wallet();
    const outcome = settleWager(wager(K.Loss), w, ctx());
    expect(outcome).toEqual({ type: "processed" });
    expect(w.balance.amount).toBe("100.00");
    expect(w.version).toBe(1);
  });
});

describe("REFUND", () => {
  test("exige referência", () => {
    expect(() => wager(K.Refund)).toThrow();
  });

  test("devolve o valor do BET", () => {
    const w = wallet();
    const bet = wager(K.Bet, { externalTransactionId: "bet-1", amount: "40.00" });
    settleWager(bet, w, ctx());
    const refund = wager(K.Refund, { referenceExternalTransactionId: "bet-1", amount: "40.00" });

    const outcome = settleWager(refund, w, ctx({ reference: bet }));
    expect(outcome.type).toBe("processed");
    expect(w.balance.amount).toBe("100.00");
  });

  test("só referencia BET", () => {
    const win = processed(wager(K.Win, { externalTransactionId: "win-1" }));
    const refund = wager(K.Refund, { referenceExternalTransactionId: "win-1" });
    expect(settleWager(refund, wallet(), ctx({ reference: win }))).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("valor diferente da referência: REVERSAL_AMOUNT_MISMATCH", () => {
    const bet = processed(wager(K.Bet, { externalTransactionId: "bet-1", amount: "40.00" }));
    const refund = wager(K.Refund, { referenceExternalTransactionId: "bet-1", amount: "20.00" });
    expect(settleWager(refund, wallet(), ctx({ reference: bet }))).toEqual({
      type: "rejected",
      code: FailureCode.ReversalAmountMismatch,
    });
  });

  test("uma vez só: REFERENCE_ALREADY_REVERSED", () => {
    const bet = processed(wager(K.Bet, { externalTransactionId: "bet-1" }));
    const refund = wager(K.Refund, { referenceExternalTransactionId: "bet-1" });
    expect(settleWager(refund, wallet(), ctx({ reference: bet, referenceAlreadyReversed: true }))).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("BET rejeitado não pode ser estornado: REFERENCE_NOT_PROCESSED", () => {
    const bet = wager(K.Bet, { externalTransactionId: "bet-1", amount: "500.00" });
    settleWager(bet, wallet(), ctx());
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);

    const refund = wager(K.Refund, { referenceExternalTransactionId: "bet-1", amount: "500.00" });
    expect(settleWager(refund, wallet(), ctx({ reference: bet }))).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test("referência ainda não chegou: aguarda sem decidir", () => {
    const w = wallet();
    const refund = wager(K.Refund, { referenceExternalTransactionId: "bet-404" });
    expect(settleWager(refund, w, ctx())).toEqual({ type: "waiting_reference" });
    expect(refund.status).toBe(WagerTransactionStatus.Pending);
    expect(w.balance.amount).toBe("100.00");
  });
});

describe("ROLLBACK", () => {
  test("de BET credita", () => {
    const w = wallet();
    const bet = wager(K.Bet, { externalTransactionId: "bet-1", amount: "10.00" });
    settleWager(bet, w, ctx());
    const rollback = wager(K.Rollback, { referenceExternalTransactionId: "bet-1", amount: "10.00" });
    const outcome = settleWager(rollback, w, ctx({ reference: bet }));

    expect(outcome.type === "processed" && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe("100.00");
  });

  test("de WIN debita", () => {
    const w = wallet();
    const win = wager(K.Win, { externalTransactionId: "win-1", amount: "30.00" });
    settleWager(win, w, ctx());
    const rollback = wager(K.Rollback, { referenceExternalTransactionId: "win-1", amount: "30.00" });
    const outcome = settleWager(rollback, w, ctx({ reference: win }));

    expect(outcome.type === "processed" && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe("100.00");
  });

  test("de REFUND debita", () => {
    const w = wallet();
    const bet = wager(K.Bet, { externalTransactionId: "bet-1" });
    settleWager(bet, w, ctx());
    const refund = wager(K.Refund, { externalTransactionId: "refund-1", referenceExternalTransactionId: "bet-1" });
    settleWager(refund, w, ctx({ reference: bet }));
    const rollback = wager(K.Rollback, { referenceExternalTransactionId: "refund-1" });

    const outcome = settleWager(rollback, w, ctx({ reference: refund }));
    expect(outcome.type === "processed" && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe("90.00");
  });

  test("de LOSS não é permitido", () => {
    const loss = processed(wager(K.Loss, { externalTransactionId: "loss-1" }));
    const rollback = wager(K.Rollback, { referenceExternalTransactionId: "loss-1" });
    expect(settleWager(rollback, wallet(), ctx({ reference: loss }))).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("que deixaria saldo negativo: REVERSAL_INSUFFICIENT_FUNDS (diferente de aposta sem saldo)", () => {
    const w = wallet("0");
    const win = wager(K.Win, { externalTransactionId: "win-1", amount: "50.00" });
    settleWager(win, w, ctx());
    // jogador gastou o prêmio
    settleWager(wager(K.Bet, { amount: "45.00" }), w, ctx());
    expect(w.balance.amount).toBe("5.00");

    const rollback = wager(K.Rollback, { referenceExternalTransactionId: "win-1", amount: "50.00" });
    expect(settleWager(rollback, w, ctx({ reference: win }))).toEqual({
      type: "rejected",
      code: FailureCode.ReversalInsufficientFunds,
    });
    expect(w.balance.amount).toBe("5.00");
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("referência em PENDING_REFERENCE também faz esperar", () => {
    const win = wager(K.Win, { externalTransactionId: "win-1", referenceExternalTransactionId: "bet-404" });
    win.markPendingReference(new Date(NOW.getTime() + 1000));
    const rollback = wager(K.Rollback, { referenceExternalTransactionId: "win-1" });
    expect(settleWager(rollback, wallet(), ctx({ reference: win }))).toEqual({ type: "waiting_reference" });
  });
});

describe("conflito de moeda na referência", () => {
  test("reversão em moeda diferente da wallet é rejeitada antes de olhar a referência", () => {
    const usd = Money.from({ amount: "10.00", currency: "USD" });
    const bet = processed(wager(K.Bet, { externalTransactionId: "bet-1" }));
    const refund = wager(K.Refund, { referenceExternalTransactionId: "bet-1", money: usd });
    expect(settleWager(refund, wallet(), ctx({ reference: bet }))).toEqual({
      type: "rejected",
      code: FailureCode.CurrencyMismatch,
    });
  });
});
