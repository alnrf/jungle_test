/**
 * Códigos estáveis de rejeição/falha. O provedor decide o que fazer
 * olhando só pro código, então não renomear sem versionar o contrato.
 * A tabela com "pode reenviar?" está no ARCHITECTURE.md.
 */
export const FailureCode = {
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds: "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch: "CURRENCY_MISMATCH",
  WalletNotFound: "WALLET_NOT_FOUND",
  WalletPlayerMismatch: "WALLET_PLAYER_MISMATCH",
  ReferenceNotFound: "REFERENCE_NOT_FOUND",
  ReferenceMismatch: "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed: "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
  ReversalAmountMismatch: "REVERSAL_AMOUNT_MISMATCH",
  ProcessingError: "PROCESSING_ERROR",
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

const ALL = new Set<string>(Object.values(FailureCode));

export const isFailureCode = (value: string): value is FailureCode => ALL.has(value);
