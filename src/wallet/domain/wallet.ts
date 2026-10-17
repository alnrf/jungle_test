import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from "../../shared/domain/errors";
import { Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial (version = 1). O lançamento de
   * abertura é gerado por openingEntry(), dentro da mesma transação SQL.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("initial balance cannot be negative");
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** undefined quando o saldo inicial é zero (não existe lançamento sem valor). */
  openingEntry(transactionId: string): WalletLedgerEntry | undefined {
    if (this._balance.isZero()) return undefined;
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  debit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, transactionId, money, at);
  }

  credit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, transactionId, money, at);
  }

  apply(direction: LedgerDirection, transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError("movement amount must be positive");
    }

    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(`balance ${before} is not enough for ${money}`);
    }

    // saldo e lançamento nascem juntos, não tem como mudar um sem o outro
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (!money.hasCurrency(this.currency)) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
