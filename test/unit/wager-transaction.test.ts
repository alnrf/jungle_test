import { describe, expect, test } from "bun:test";
import { InvalidTransactionError, InvalidTransactionStateError } from "../../src/shared/domain/errors";
import { LedgerDirection } from "../../src/wallet/domain/ledger-entry";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { canonicalJson, wagerPayloadHash } from "../../src/wagering/domain/payload-hash";
import { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction";
import { brl, NOW, wager, WagerTransactionKind as K } from "./helpers";

describe("WagerTransaction", () => {
  test("nasce PENDING", () => {
    expect(wager(K.Bet).status).toBe(WagerTransactionStatus.Pending);
  });

  test("OPENING não pode vir de provedor", () => {
    expect(() => wager(K.Opening)).toThrow(InvalidTransactionError);
  });

  test("provedor 'internal' só pode OPENING", () => {
    expect(() => wager(K.Bet, { providerId: "internal" })).toThrow(InvalidTransactionError);
  });

  test("valor zero é recusado", () => {
    expect(() => wager(K.Bet, { amount: "0" })).toThrow(InvalidTransactionError);
  });

  test("REFUND e ROLLBACK exigem referência; BET não aceita", () => {
    expect(() => wager(K.Refund)).toThrow(InvalidTransactionError);
    expect(() => wager(K.Rollback)).toThrow(InvalidTransactionError);
    expect(() => wager(K.Bet, { referenceExternalTransactionId: "x" })).toThrow(InvalidTransactionError);
  });

  test("não pode referenciar a si mesma", () => {
    expect(() =>
      wager(K.Refund, { externalTransactionId: "a", referenceExternalTransactionId: "a" }),
    ).toThrow(InvalidTransactionError);
  });

  test.each([
    ["markProcessed", (tx: ReturnType<typeof wager>) => tx.markProcessed(undefined, NOW, brl("1"))],
    ["reject", (tx: ReturnType<typeof wager>) => tx.reject(FailureCode.InsufficientFunds, NOW)],
    ["fail", (tx: ReturnType<typeof wager>) => tx.fail(FailureCode.ProcessingError, NOW)],
    ["markPendingReference", (tx: ReturnType<typeof wager>) => tx.markPendingReference(NOW)],
  ])("estado terminal não aceita %s", (_, transition) => {
    for (const finish of [
      (tx: ReturnType<typeof wager>) => tx.markProcessed(undefined, NOW, brl("1")),
      (tx: ReturnType<typeof wager>) => tx.reject(FailureCode.InsufficientFunds, NOW),
      (tx: ReturnType<typeof wager>) => tx.fail(FailureCode.ProcessingError, NOW),
    ]) {
      const tx = wager(K.Bet);
      finish(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
    }
  });

  test("PENDING_REFERENCE conta tentativas a partir do primeiro reagendamento", () => {
    const tx = wager(K.Refund, { referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(NOW);
    expect(tx.referenceAttempts).toBe(0);
    tx.markPendingReference(NOW);
    tx.markPendingReference(NOW);
    expect(tx.referenceAttempts).toBe(2);
    tx.markProcessed("ref", NOW, brl("1"));
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  test("affectsBalance / requiresReference", () => {
    expect(wager(K.Loss).affectsBalance()).toBe(false);
    expect(wager(K.Bet).affectsBalance()).toBe(true);
    expect(wager(K.Refund, { referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
    expect(wager(K.Win).requiresReference()).toBe(false);
  });

  test("direção no ledger", () => {
    const bet = wager(K.Bet);
    const win = wager(K.Win);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rollback = wager(K.Rollback, { referenceExternalTransactionId: "x" });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => wager(K.Loss).ledgerDirectionFor()).toThrow();
  });
});

describe("idempotência / payload hash", () => {
  const payload = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };

  test("JSON canônico ordena chaves e ignora undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: "x" } })).toBe('{"a":{"c":"x"},"b":1}');
  });

  test("ordem das chaves não muda o hash", () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as typeof payload;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
  });

  test("mesma chave com payload diferente não bate", () => {
    const tx = wager(K.Bet, { payloadHash: wagerPayloadHash(payload) });
    expect(tx.matchesPayload(wagerPayloadHash(payload))).toBe(true);
    expect(tx.matchesPayload(wagerPayloadHash({ ...payload, money: { amount: "25.01", currency: "BRL" } }))).toBe(
      false,
    );
    expect(tx.matchesPayload(wagerPayloadHash({ ...payload, roundId: "round-988" }))).toBe(false);
  });

  test("campo de referência entra no hash", () => {
    expect(wagerPayloadHash({ ...payload, referenceExternalTransactionId: "x" })).not.toBe(wagerPayloadHash(payload));
  });

  // se esse teste quebrar, o algoritmo mudou e replays antigos viram conflito
  test("vetor fixo (mesmo valor de: printf '<json canônico>' | sha256sum)", () => {
    expect(wagerPayloadHash(payload)).toBe("629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344");
  });
});
