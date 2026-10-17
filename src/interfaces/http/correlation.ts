import type { NextFunction, Request, Response } from "express";
import { newId } from "../../shared/domain/ids";
import type { AppLogger } from "../../infra/observability/logger";
import { logContext } from "../../infra/observability/log-context";

const VALID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Abre o contexto de log da request. Middleware do express pra envolver o handler inteiro. */
export function correlationMiddleware(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header("x-correlation-id");
    const correlationId = incoming && VALID.test(incoming) ? incoming : newId();
    res.setHeader("X-Correlation-Id", correlationId);

    logContext.run({ correlationId }, () => {
      const started = performance.now();
      res.on("finish", () => {
        if (req.path.startsWith("/health") || req.path === "/metrics") return;
        logger.info("http request", {
          method: req.method,
          path: req.route?.path ?? req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        });
      });
      next();
    });
  };
}
