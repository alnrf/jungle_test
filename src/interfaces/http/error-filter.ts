import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import {
  IdempotencyConflictError,
  InvalidCursorError,
  NotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors";
import { AppLogger } from "../../infra/observability/logger";
import { logContext } from "../../infra/observability/log-context";
import { DomainError, InvalidMoneyError, InvalidTransactionError } from "../../shared/domain/errors";
import { ValidationError } from "../contracts";

/*
 * Mesmo mapeamento em todos os endpoints:
 *
 *   400  payload inválido               -> corrigir antes de reenviar
 *   404  wallet/transação não existe
 *   409  conflito (idempotência, wallet duplicada) -> não reenviar igual
 *   422  rejeição de regra de negócio   (ver WageringController; vem com failureCode)
 *   202  aceita, aguardando referência  (idem)
 *   503  falha transitória              -> reenviar com a mesma Idempotency-Key
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code, message, details } = this.describe(exception);

    if (status >= 500) {
      this.logger.failure("request failed", exception, { status, code });
    }
    if (status === 503) res.setHeader("Retry-After", "1");

    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
      correlationId: logContext.get().correlationId,
    });
  }

  private describe(exception: unknown): { status: number; code: string; message: string; details?: unknown } {
    if (exception instanceof ValidationError) {
      return { status: 400, code: exception.code, message: exception.message, details: exception.details };
    }
    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidTransactionError ||
      exception instanceof InvalidCursorError
    ) {
      return { status: 400, code: exception.code, message: exception.message };
    }
    if (exception instanceof IdempotencyConflictError || exception instanceof WalletAlreadyExistsError) {
      return { status: 409, code: exception.code, message: exception.message };
    }
    if (exception instanceof WalletNotFoundError || exception instanceof NotFoundError) {
      return { status: 404, code: exception.code, message: exception.message };
    }
    if (exception instanceof DomainError) {
      return { status: 422, code: exception.code, message: exception.message };
    }
    if (exception instanceof TransientInfrastructureError) {
      return { status: 503, code: "TEMPORARILY_UNAVAILABLE", message: "try again with the same Idempotency-Key" };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // 400 do próprio Nest/body-parser é JSON malformado
      if (status === 400) return { status, code: "VALIDATION_ERROR", message: "malformed request body" };
      return { status, code: status === 404 ? "NOT_FOUND" : "HTTP_ERROR", message: exception.message };
    }
    return { status: 500, code: "INTERNAL_ERROR", message: "unexpected error" };
  }
}
