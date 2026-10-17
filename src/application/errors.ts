import { DomainError } from "../shared/domain/errors";

export class IdempotencyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_CONFLICT";
}

export class WalletNotFoundError extends DomainError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(readonly walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class NotFoundError extends DomainError {
  readonly code = "NOT_FOUND";
}

export class InvalidCursorError extends DomainError {
  readonly code = "INVALID_CURSOR";
}

/**
 * Banco/fila fora, lock timeout, deadlock que esgotou os retries...
 * O cliente pode (e deve) tentar de novo.
 */
export class TransientInfrastructureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TransientInfrastructureError";
  }
}

/** Unique violation que não foi tratada como retry. O use case decide o que significa. */
export class UniqueViolationError extends Error {
  constructor(readonly constraint: string | undefined, cause?: unknown) {
    super(`unique constraint violated: ${constraint ?? "unknown"}`, { cause });
    this.name = "UniqueViolationError";
  }
}

/** O update condicionado por version não afetou linha nenhuma. */
export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}
