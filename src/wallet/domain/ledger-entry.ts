import { InvalidLedgerEntryError } from "../../shared/domain/errors";
import { newId } from "../../shared/domain/ids";
import { Money } from "../../shared/domain/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export const oppositeDirection = (direction: LedgerDirection): LedgerDirection =>
  direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  id: string;
  /** posição global no ledger, atribuída pelo banco. Só existe depois de persistido. */
  sequence?: string;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
    public readonly sequence?: string,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      newId(),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError("ledger entry amount must be positive");
    }
    if (entry.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("ledger entry would leave a negative balance");
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `unbalanced entry: ${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
      state.sequence,
    );
  }

  /** Valor com sinal: + crédito, - débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  isBalanced(): boolean {
    // add/subtract já lançam se as moedas forem diferentes
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }
}
