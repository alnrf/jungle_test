import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { v7 } from "uuid";
import type { WagerBody } from "./api";
import { BASE_ENV } from "./env";

export const QUEUES = {
  wager: "wager-transactions.fifo",
  dlq: "wager-transactions-dlq.fifo",
  events: "wagering-events.fifo",
};

export class TestSqs {
  readonly client = new SQSClient({
    region: "us-east-1",
    endpoint: BASE_ENV.SQS_ENDPOINT,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  private urls = new Map<string, string>();

  async url(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const res = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    this.urls.set(name, res.QueueUrl!);
    return res.QueueUrl!;
  }

  async purgeAll(): Promise<void> {
    for (const name of Object.values(QUEUES)) {
      await this.client.send(new PurgeQueueCommand({ QueueUrl: await this.url(name) }));
    }
  }

  /** Publica um WagerTransactionRequested. messageId e dedup podem ser forçados pra simular redelivery. */
  async sendWager(
    body: WagerBody,
    opts: { messageId?: string; dedupId?: string; idempotencyKey?: string } = {},
  ): Promise<string> {
    const messageId = opts.messageId ?? v7();
    await this.sendRaw(
      JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: { ...body, idempotencyKey: opts.idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}` },
      }),
      body.walletId,
      opts.dedupId ?? v7(),
    );
    return messageId;
  }

  async sendRaw(body: string, groupId = "test", dedupId = v7()): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(QUEUES.wager),
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId,
      }),
    );
  }

  async depth(name: string): Promise<{ visible: number; inFlight: number }> {
    const res = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.url(name),
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    return {
      visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }

  /** Lê (e apaga) tudo que estiver na fila até ela ficar vazia. */
  async drain(name: string, timeoutMs = 3_000): Promise<Message[]> {
    const out: Message[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: await this.url(name),
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ["All"],
        }),
      );
      const messages = res.Messages ?? [];
      if (messages.length === 0 && out.length > 0) break;
      for (const m of messages) {
        out.push(m);
        await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.url(name), ReceiptHandle: m.ReceiptHandle }));
      }
    }
    return out;
  }
}
