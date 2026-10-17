/**
 * Erro de regra de negócio. Tudo que estende essa classe é "esperado":
 * vira resposta 4xx na API e ack na fila.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}

export class InvalidTransactionError extends DomainError {
  readonly code = "INVALID_TRANSACTION";
}

/**
 * Transição de estado inválida não é caminho de negócio, é bug.
 * Por isso não estende DomainError.
 */
export class InvalidTransactionStateError extends Error {
  constructor(transactionId: string, from: string, to: string) {
    super(`transaction ${transactionId} cannot go from ${from} to ${to}`);
    this.name = "InvalidTransactionStateError";
  }
}
