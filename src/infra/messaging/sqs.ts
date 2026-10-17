import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../../config/env";

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    endpoint: env.SQS_ENDPOINT,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 3,
  });
}

/** Resolve (e guarda) as URLs das filas pelo nome. */
@Injectable()
export class SqsQueues {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  wagerQueueUrl(): Promise<string> {
    return this.url(this.env.SQS_WAGER_QUEUE);
  }

  deadLetterQueueUrl(): Promise<string> {
    return this.url(this.env.SQS_WAGER_DLQ);
  }

  eventsQueueUrl(): Promise<string> {
    return this.url(this.env.SQS_EVENTS_QUEUE);
  }

  private url(name: string): Promise<string> {
    let pending = this.cache.get(name);
    if (!pending) {
      pending = this.sqs.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => {
        if (!r.QueueUrl) throw new Error(`queue ${name} not found`);
        return r.QueueUrl;
      });
      // falhou? não deixa a promise rejeitada no cache
      pending.catch(() => this.cache.delete(name));
      this.cache.set(name, pending);
    }
    return pending;
  }
}
