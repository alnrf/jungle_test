import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { ResolvePendingReferences } from "../../application/wager/resolve-pending-references";
import { ENV, type Env } from "../../config/env";
import { AppLogger } from "../observability/logger";
import { PollingLoop } from "./polling-loop";

const BATCH = 20;

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    private readonly resolver: ResolvePendingReferences,
    logger: AppLogger,
    @Inject(ENV) env: Env,
  ) {
    this.loop = new PollingLoop(
      "pending reference worker",
      env.PENDING_REFERENCE_POLL_MS,
      async () => (await this.resolver.runOnce(BATCH)) >= BATCH,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}
