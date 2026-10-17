import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, Header, Res } from "@nestjs/common";
import type { Response } from "express";
import { SqsQueues } from "../../infra/messaging/sqs";
import { Metrics } from "../../infra/observability/metrics";

const CHECK_TIMEOUT_MS = 2_000;

/** Sem guard: health e métricas ficam abertos (são consumidos pela infraestrutura). */
@Controller()
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
    private readonly metrics: Metrics,
  ) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, queue] = await Promise.all([
      check(() => this.orm.em.getConnection().execute("select 1")),
      check(async () => {
        await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.queues.wagerQueueUrl(),
            AttributeNames: ["QueueArn"],
          }),
        );
      }),
    ]);
    const ok = database === "up" && queue === "up";
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks: { database, sqs: queue } };
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  metricsText() {
    return this.metrics.registry.metrics();
  }
}

async function check(fn: () => Promise<unknown>): Promise<"up" | "down"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
