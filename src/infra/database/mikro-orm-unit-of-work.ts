import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import {
  ConcurrencyConflictError,
  TransientInfrastructureError,
  UniqueViolationError,
} from "../../application/errors";
import { UnitOfWork, type Repositories, type RunOptions } from "../../application/ports";
import { ENV, type Env } from "../../config/env";
import { Metrics } from "../observability/metrics";
import { constraintOf, isConnectionError, retryableReason, sqlStateOf, SqlState } from "./pg-errors";
import { createRepositories } from "./repositories";

const MAX_ATTEMPTS = 4;

@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
    @Inject(ENV) private readonly env: Env,
  ) {
    super();
  }

  async run<T>(work: (repos: Repositories) => Promise<T>, options: RunOptions = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          // sem isso um lock esquecido segura a request até o timeout do cliente
          await em.execute(`set local lock_timeout = '${this.env.DB_LOCK_TIMEOUT_MS}ms'`);
          return work(createRepositories(em));
        });
      } catch (err) {
        const reason = this.retryReason(err, options);
        if (reason && attempt < MAX_ATTEMPTS) {
          this.metrics.retries.inc({ operation: "db_transaction", reason });
          if (reason !== "unique_violation") this.metrics.lockConflicts.inc({ reason });
          await sleep(backoff(attempt));
          continue;
        }
        throw this.translate(err, reason);
      }
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await work(createRepositories(this.orm.em.fork()));
    } catch (err) {
      throw this.translate(err, undefined);
    }
  }

  private retryReason(err: unknown, options: RunOptions): string | undefined {
    if (err instanceof ConcurrencyConflictError) return "version_conflict";
    const reason = retryableReason(err);
    if (reason) return reason;
    if (
      sqlStateOf(err) === SqlState.UniqueViolation &&
      options.retryOnUniqueConstraints?.includes(constraintOf(err) ?? "")
    ) {
      return "unique_violation";
    }
    return undefined;
  }

  private translate(err: unknown, retryReason: string | undefined): unknown {
    if (retryReason || isConnectionError(err)) {
      return new TransientInfrastructureError(
        retryReason ? `database contention (${retryReason})` : "database unavailable",
        err,
      );
    }
    if (sqlStateOf(err) === SqlState.UniqueViolation) {
      return new UniqueViolationError(constraintOf(err), err);
    }
    return err;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 10ms, 20ms, 40ms com jitter, pra duas transações que colidiram não colidirem de novo
const backoff = (attempt: number) => 10 * 2 ** (attempt - 1) * (0.5 + Math.random());
