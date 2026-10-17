import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
} from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "../../src/wallet/domain/ledger-entry";
import { Wallet } from "../../src/wallet/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-10-12T12:00:00Z");

const openWallet = (amount = "100.00") =>
  Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: brl(amount), now });

describe("Wallet", () => {
  test("abre com version 1 e moeda do saldo inicial", () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("lançamento de abertura existe só quando o saldo inicial é positivo", () => {
    const entry = openWallet().openingEntry("tx-open");
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.amount).toBe("0.00");
    expect(entry?.balanceAfter.amount).toBe("100.00");
    expect(openWallet("0").openingEntry("tx-open")).toBeUndefined();
  });

  test("débito gera lançamento consistente e incrementa a versão", () => {
    const wallet = openWallet();
    const entry = wallet.debit("tx-1", brl("30.00"), now);

    expect(wallet.balance.amount).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("70.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("crédito", () => {
    const wallet = openWallet();
    wallet.credit("tx-1", brl("0.50"), now);
    expect(wallet.balance.amount).toBe("100.50");
  });

  test("não deixa o saldo ficar negativo e não muda nada quando recusa", () => {
    const wallet = openWallet();
    expect(() => wallet.debit("tx-1", brl("100.01"), now)).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("pode zerar o saldo", () => {
    const wallet = openWallet();
    wallet.debit("tx-1", brl("100.00"), now);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("recusa moeda diferente da wallet", () => {
    const wallet = openWallet();
    expect(() => wallet.credit("tx-1", Money.from({ amount: "1.00", currency: "USD" }), now)).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.version).toBe(1);
  });

  test("rehydrate não revalida nada, só reconstrói", () => {
    const wallet = Wallet.rehydrate({
      id: "w-1",
      playerId: "p-1",
      currency: "BRL",
      balance: brl("5.00"),
      version: 42,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.version).toBe(42);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    walletId: "w-1",
    transactionId: "tx-1",
    createdAt: now,
  };

  test("valida a aritmética na criação", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("50.00"),
        balanceAfter: brl("45.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("não aceita valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.zero("BRL"),
        balanceBefore: brl("50.00"),
        balanceAfter: brl("50.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("é imutável de verdade (frozen)", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("10.00"),
      balanceBefore: brl("50.00"),
      balanceAfter: brl("60.00"),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = "DEBIT";
    }).toThrow();
  });
});
