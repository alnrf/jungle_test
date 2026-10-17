import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 100n;
// 18 dígitos inteiros + 2 decimais = numeric(20,2) no banco
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário com escala fixa de 2 casas.
 *
 * Internamente guarda centavos em bigint. Como a escala é fixa e a gente
 * não faz multiplicação/divisão (sem juros, sem câmbio), bigint resolve sem
 * precisar de lib de decimal.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada de contrato externo: rejeita negativos. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("money must be an object");
    }
    const currency = Money.parseCurrency(props.currency);
    return new Money(Money.parseAmount(props.amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  /** Valor vindo do banco (numeric). Pode ser negativo, ex.: diferença de reconciliação. */
  static fromPersistence(amount: string, currency: string): Money {
    const negative = amount.startsWith("-");
    const cents = Money.parseAmount(negative ? amount.slice(1) : amount);
    return new Money(negative ? -cents : cents, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError("currency must be an ISO-4217 code (3 uppercase letters)");
    }
    return currency;
  }

  private static parseAmount(amount: unknown): bigint {
    // number é recusado de propósito: 0.1 + 0.2 já chega errado aqui
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`invalid amount "${amount}"`);
    }
    const [int = "0", frac = ""] = amount.split(".");
    return BigInt(int) * FACTOR + BigInt(frac.padEnd(SCALE, "0"));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  /** "25.00", "-3.10" */
  get amount(): string {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    const int = abs / FACTOR;
    const frac = (abs % FACTOR).toString().padStart(SCALE, "0");
    return `${this.cents < 0n ? "-" : ""}${int}.${frac}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
