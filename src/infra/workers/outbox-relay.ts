import { Inject, Injectable, type OnApplicationBootstrap, type BeforeApplicationShutdown } from "@nestjs/common";
import { UnitOfWork } from "../../application/ports";
import { ENV, type Env } from "../../config/env";
import { Clock } from "../../shared/domain/clock";
import { EventPublisher } from "../messaging/event-publisher";
import { AppLogger } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { PollingLoop } from "./polling-loop";

/**
 * Publica a outbox.
 *
 * Cada lote é pego com FOR UPDATE SKIP LOCKED dentro de uma transação, que
 * fica aberta enquanto publica. Assim dois relays nunca pegam o mesmo evento
 * ao mesmo tempo. Se o processo morrer depois de publicar e antes do commit,
 * o lock solta e outro relay publica de novo: entrega at-least-once, o
 * consumidor deduplica por eventId.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;
  private lastStatsAt = 0;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.loop = new PollingLoop("outbox relay", env.OUTBOX_POLL_MS, () => this.tick(), logger);
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  private async tick(): Promise<boolean> {
    const published = await this.publishBatch();
    await this.refreshStats();
    return published >= this.env.OUTBOX_BATCH_SIZE;
  }

  /** Exposto pros testes. Devolve quantos eventos foram processados no lote. */
  async publishBatch(): Promise<number> {
    return this.uow.run(async (repos) => {
      const batch = await repos.outbox.claimDue(this.clock.now(), this.env.OUTBOX_BATCH_SIZE);
      if (batch.length === 0) return 0;

      const failed = await this.publisher.publish(batch);
      const now = this.clock.now();
      const published: string[] = [];
      for (const message of batch) {
        const error = failed.get(message.id);
        if (error === undefined) {
          message.markPublished(now);
          published.push(message.id);
          this.metrics.outboxPublished.inc({ event_type: message.eventType });
        } else {
          message.scheduleRetry(now, error);
          this.metrics.outboxPublishFailures.inc();
          this.metrics.retries.inc({ operation: "outbox_publish", reason: "broker_error" });
          await repos.outbox.save(message);
        }
      }
      await repos.outbox.markPublished(published, now);
      if (failed.size > 0) {
        this.logger.warning("some outbox events failed to publish", { failed: failed.size, batch: batch.length });
      }
      return batch.length;
    });
  }

  private async refreshStats(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStatsAt < 5_000) return;
    this.lastStatsAt = now;
    const stats = await this.uow.read((repos) => repos.outbox.stats(this.clock.now()));
    this.metrics.outboxPending.set(stats.pending);
    this.metrics.outboxLag.set(stats.oldestAgeSeconds);
  }
}
