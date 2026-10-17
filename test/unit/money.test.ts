import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("normaliza pra 2 casas", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("25.5").amount).toBe("25.50");
    expect(brl("0.01").amount).toBe("0.01");
    expect(brl("0").amount).toBe("0.00");
  });

  test("soma e subtração são exatas (o clássico 0.1 + 0.2)", () => {
    expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
    expect(brl("10.00").subtract(brl("10.01")).amount).toBe("-0.01");
  });

  test("valores grandes não perdem precisão", () => {
    const big = brl("999999999999999999.99");
    expect(big.amount).toBe("999999999999999999.99");
    expect(big.subtract(brl("0.01")).amount).toBe("999999999999999999.98");
  });

  test.each([
    ["mais de 2 casas", "1.001"],
    ["notação científica", "1e3"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["vazio", ""],
    ["negativo", "-1.00"],
    ["sinal de +", "+1.00"],
    ["zero à esquerda", "01.00"],
    ["vírgula", "1,00"],
    ["ponto sem decimais", "1."],
    ["espaço", " 1.00"],
    ["mais de 18 dígitos inteiros", "1000000000000000000.00"],
  ])("rejeita %s (%p)", (_, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita number no lugar de string", () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejeita moeda inválida", () => {
    expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1.00", currency: "REAL" })).toThrow(InvalidMoneyError);
  });

  test("operação entre moedas diferentes lança erro de domínio", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("equals considera a moeda", () => {
    expect(brl("1.00").equals(brl("1"))).toBe(true);
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
  });

  test("é imutável", () => {
    const a = brl("10.00");
    a.add(brl("5.00"));
    a.negate();
    expect(a.amount).toBe("10.00");
  });

  test("predicados", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("1.00").isPositive()).toBe(true);
    expect(brl("1.00").negate().isNegative()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
  });

  test("fromPersistence aceita negativo (diferença de reconciliação)", () => {
    expect(Money.fromPersistence("-3.10", "BRL").amount).toBe("-3.10");
    expect(Money.fromPersistence("975.00", "BRL").toString()).toBe("975.00 BRL");
  });
});
