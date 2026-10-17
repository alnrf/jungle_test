import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const logContext = {
  run<T>(ctx: LogContext, fn: () => T): T {
    return storage.run({ ...ctx }, fn);
  },

  get(): LogContext {
    return storage.getStore() ?? {};
  },

  /** Acrescenta campos ao contexto atual (ex.: transactionId depois que foi gerado). */
  assign(fields: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
};
