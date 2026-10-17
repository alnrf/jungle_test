import { Injectable, type LoggerService } from "@nestjs/common";
import { hostname } from "node:os";
import { logContext } from "./log-context";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Uma linha JSON por log. Pega correlationId/messageId/etc. do AsyncLocalStorage.
 *
 * Regra: nada de payload, valor de aposta ou saldo em log. Só ids e códigos.
 */
@Injectable()
export class AppLogger implements LoggerService {
  private static minLevel: Level = (process.env.LOG_LEVEL as Level) ?? "info";
  private static instance = process.env.INSTANCE_ID ?? `${hostname()}:${process.pid}`;

  static configure(level: Level, instanceId?: string): void {
    AppLogger.minLevel = level;
    if (instanceId) AppLogger.instance = instanceId;
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write("info", msg, fields);
  }

  warning(msg: string, fields?: Record<string, unknown>): void {
    this.write("warn", msg, fields);
  }

  failure(msg: string, err: unknown, fields?: Record<string, unknown>): void {
    this.write("error", msg, { ...fields, ...describeError(err) });
  }

  // ---- interface do Nest (usada pelo framework)

  log(message: unknown, ...params: unknown[]): void {
    this.write("info", String(message), nestContext(params));
  }

  error(message: unknown, ...params: unknown[]): void {
    const [trace] = params;
    this.write("error", String(message), {
      ...nestContext(params),
      ...(typeof trace === "string" && params.length > 1 ? { stack: trace } : {}),
    });
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", String(message), nestContext(params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", String(message), nestContext(params));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write("debug", String(message), nestContext(params));
  }

  private write(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[AppLogger.minLevel]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      instance: AppLogger.instance,
      ...logContext.get(),
      ...fields,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}

function nestContext(params: unknown[]): Record<string, unknown> {
  const last = params[params.length - 1];
  return typeof last === "string" ? { context: last } : {};
}

export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const isSqlError = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
    return {
      error: err.name,
      errorMessage: isSqlError ? stripQuery(err.message) : err.message,
      ...(typeof code === "string" ? { errorCode: code } : {}),
      // a primeira linha do stack repete a mensagem (e a query, no caso do ORM)
      stack: err.stack?.split("\n").slice(1, 6).join("\n"),
    };
  }
  return { error: String(err) };
}

/**
 * O MikroORM monta a mensagem como "<sql com os valores> - <erro do postgres>".
 * Os valores incluem payload e saldo, então só a parte do postgres vai pro log.
 */
function stripQuery(message: string): string {
  const separator = message.lastIndexOf(" - ");
  return separator >= 0 ? message.slice(separator + 3) : message;
}
