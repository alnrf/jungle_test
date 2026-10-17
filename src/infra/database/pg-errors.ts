/*
 * O MikroORM embrulha o erro do driver mas copia as propriedades (code,
 * constraint...), então dá pra olhar direto no erro ou no `previous`.
 */

interface PgLikeError {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  previous?: unknown;
  name?: unknown;
}

function chain(err: unknown): PgLikeError[] {
  const out: PgLikeError[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    out.push(cur as PgLikeError);
    cur = (cur as PgLikeError).previous ?? (cur as { cause?: unknown }).cause;
  }
  return out;
}

export function sqlStateOf(err: unknown): string | undefined {
  for (const e of chain(err)) {
    for (const candidate of [e.sqlState, e.code]) {
      if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
    }
  }
  return undefined;
}

export function constraintOf(err: unknown): string | undefined {
  for (const e of chain(err)) {
    if (typeof e.constraint === "string") return e.constraint;
  }
  return undefined;
}

export const SqlState = {
  UniqueViolation: "23505",
  CheckViolation: "23514",
  SerializationFailure: "40001",
  DeadlockDetected: "40P01",
  LockNotAvailable: "55P03",
  AdminShutdown: "57P01",
  CannotConnectNow: "57P03",
} as const;

/** Vale a pena rodar a transação de novo. */
export function retryableReason(err: unknown): string | undefined {
  switch (sqlStateOf(err)) {
    case SqlState.SerializationFailure:
      return "serialization_failure";
    case SqlState.DeadlockDetected:
      return "deadlock";
    case SqlState.LockNotAvailable:
      return "lock_timeout";
    default:
      return undefined;
  }
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

export function isConnectionError(err: unknown): boolean {
  for (const e of chain(err)) {
    if (typeof e.code === "string" && CONNECTION_CODES.has(e.code)) return true;
    if (e.name === "ConnectionException") return true;
    const state = typeof e.code === "string" ? e.code : undefined;
    // classe 08 = connection exception
    if (state?.startsWith("08") || state === SqlState.AdminShutdown || state === SqlState.CannotConnectNow) {
      return true;
    }
  }
  const message = err instanceof Error ? err.message : "";
  return /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(message);
}
