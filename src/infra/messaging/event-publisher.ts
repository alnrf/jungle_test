import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import type { OutboxMessage } from "../../messaging/domain/outbox-message";
import { SqsQueues } from "./sqs";

export abstract class EventPublisher {
  /** Publica e devolve os ids que falharam (o resto foi aceito pelo broker). */
  abstract publish(messages: OutboxMessage[]): Promise<Map<string, string>>;
}

/**
 * Publica na fila FIFO de eventos.
 *
 * - MessageGroupId = wallet: eventos da mesma wallet saem em ordem pro consumidor
 * - MessageDeduplicationId = eventId: republicação dentro de 5min é descartada
 *   pelo próprio SQS. Depois disso o consumidor deduplica pelo eventId.
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
  ) {
    super();
  }

  async publish(messages: OutboxMessage[]): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    const queueUrl = await this.queues.eventsQueueUrl();

    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      try {
        const res = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m) => ({
              Id: m.id.replaceAll("-", ""),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: groupFor(m),
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: "String", StringValue: m.eventType } },
            })),
          }),
        );
        for (const f of res.Failed ?? []) {
          const original = chunk.find((m) => m.id.replaceAll("-", "") === f.Id);
          if (original) failed.set(original.id, f.Message ?? f.Code ?? "unknown");
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (const m of chunk) failed.set(m.id, reason);
      }
    }
    return failed;
  }
}

function groupFor(message: OutboxMessage): string {
  const data = (message.payload as { data?: { walletId?: unknown } }).data;
  return typeof data?.walletId === "string" ? data.walletId : message.aggregateId;
}
