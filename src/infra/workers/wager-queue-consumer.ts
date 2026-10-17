import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { TransientInfrastructureError } from "../../application/errors";
import { SubmitWagerTransaction } from "../../application/wager/submit-wager-transaction";
import { ENV, type Env } from "../../config/env";
import { parse, wagerMessageSchema, type WagerMessage } from "../../interfaces/contracts";
import { DomainError } from "../../shared/domain/errors";
import type { WagerTransactionKind } from "../../wagering/domain/wager-transaction";
import { SqsQueues } from "../messaging/sqs";
import { AppLogger, describeError } from "../observability/logger";
import { logContext } from "../observability/log-context";
import { Metrics } from "../observability/metrics";

type MessageState = "waiting" | "processing" | "done";

/**
 * Consome wager-transactions.fifo.
 *
 * Como cada tipo de erro é tratado:
 *  - use case retornou (PROCESSED, REJECTED, PENDING_REFERENCE): ack.
 *    Rejeição de negócio é resultado, não erro; já está persistida e gerou evento.
 *  - DomainError (payload inválido, conflito de idempotência, wallet que não
 *    existe): permanente, vai direto pra DLQ. Reprocessar não muda nada.
 *  - erro transitório ou inesperado: devolve pra fila com backoff
 *    (ChangeMessageVisibility). Passou de SQS_MAX_ATTEMPTS, DLQ.
 *
 * Ack (DeleteMessage) só depois do commit. Se o processo morrer entre o
 * commit e o ack, a mensagem volta e a inbox segura a duplicata.
 */
@Injectable()
export class WagerQueueConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private receiveAbort?: AbortController;
  private batch = new Map<Message, MessageState>();
  private lastDlqCheck = 0;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
    private readonly submit: SubmitWagerTransaction,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.pollLoop();
    this.logger.info("wager queue consumer started");
  }

  /**
   * SIGTERM: para de buscar, espera o lote atual até SHUTDOWN_GRACE_MS e
   * devolve a visibilidade do que nem começou.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.receiveAbort?.abort();

    const finished = await Promise.race([
      this.loop?.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.env.SHUTDOWN_GRACE_MS)),
    ]);

    const notStarted = [...this.batch].filter(([, state]) => state === "waiting").map(([m]) => m);
    await Promise.all(notStarted.map((m) => this.changeVisibility(m, 0).catch(() => undefined)));
    this.logger.info("wager queue consumer stopped", {
      drained: finished,
      returnedToQueue: notStarted.length,
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.receive();
        if (messages.length > 0) await this.processBatch(messages);
        await this.sampleDlqDepth();
      } catch (err) {
        if (!this.running) break;
        this.logger.failure("sqs receive failed", err);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  private async receive(): Promise<Message[]> {
    this.receiveAbort = new AbortController();
    const res = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queues.wagerQueueUrl(),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.env.SQS_WAIT_SECONDS,
        VisibilityTimeout: this.env.SQS_VISIBILITY_TIMEOUT,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal: this.receiveAbort.signal },
    );
    return res.Messages ?? [];
  }

  /**
   * Mensagens do mesmo MessageGroupId em sequência (é a ordem que a FIFO
   * entregou), grupos diferentes em paralelo. A ordem ajuda mas não é a
   * garantia: o lock da wallet no banco é.
   */
  private async processBatch(messages: Message[]): Promise<void> {
    this.batch = new Map(messages.map((m) => [m, "waiting" as MessageState]));
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? "default";
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }

    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          // shutdown no meio do lote: o resto volta pra fila
          if (!this.running) return;
          this.batch.set(message, "processing");
          await this.handle(message);
          this.batch.set(message, "done");
        }
      }),
    );
    this.batch.clear();
  }

  async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");

    let parsed: WagerMessage;
    try {
      parsed = parse(wagerMessageSchema, JSON.parse(message.Body ?? ""));
    } catch (err) {
      await this.moveToDlq(message, "invalid_message", err);
      return;
    }

    const { data } = parsed;
    await logContext.run(
      {
        correlationId: parsed.correlationId ?? parsed.messageId,
        messageId: parsed.messageId,
        providerId: data.providerId,
        walletId: data.walletId,
      },
      async () => {
        try {
          const result = await this.submit.execute(
            { ...data, kind: data.kind as Exclude<WagerTransactionKind, WagerTransactionKind.Opening> },
            {
              type: "sqs",
              correlationId: parsed.correlationId ?? parsed.messageId,
              consumerName: this.env.SQS_CONSUMER_NAME,
              messageId: parsed.messageId,
            },
          );

          if (this.env.FAULT_CRASH_AFTER_COMMIT === "true") {
            // teste de crash: commit feito, ack não
            this.logger.warning("FAULT_CRASH_AFTER_COMMIT: exiting before ack");
            process.exit(137);
          }

          await this.ack(message);
          this.logger.info("wager message processed", {
            status: result.status,
            failureCode: result.failureCode,
            replay: result.idempotentReplay,
            receiveCount,
          });
        } catch (err) {
          await this.handleFailure(message, err, receiveCount);
        }
      },
    );
  }

  private async handleFailure(message: Message, err: unknown, receiveCount: number): Promise<void> {
    if (err instanceof DomainError) {
      await this.moveToDlq(message, err.code.toLowerCase(), err);
      return;
    }
    if (receiveCount >= this.env.SQS_MAX_ATTEMPTS) {
      await this.moveToDlq(message, "max_attempts_exceeded", err);
      return;
    }

    const transient = err instanceof TransientInfrastructureError;
    const delay = Math.min(2 ** receiveCount, 60);
    this.metrics.retries.inc({ operation: "sqs_message", reason: transient ? "transient" : "unexpected" });
    const fields = { receiveCount, retryInSeconds: delay };
    if (transient) {
      this.logger.warning("wager message will be retried", { ...fields, ...describeError(err) });
    } else {
      this.logger.failure("unexpected error handling wager message, will retry", err, fields);
    }
    await this.changeVisibility(message, delay).catch((e) =>
      this.logger.failure("could not change message visibility", e),
    );
  }

  private async moveToDlq(message: Message, reason: string, err: unknown): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: await this.queues.deadLetterQueueUrl(),
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            reason: { DataType: "String", StringValue: reason },
            error: {
              DataType: "String",
              StringValue: (err instanceof Error ? err.message : String(err)).slice(0, 256) || "-",
            },
          },
        }),
      );
      await this.ack(message);
      this.metrics.dlqMessages.inc({ reason });
      this.logger.warning("message moved to DLQ", { reason, sqsMessageId: message.MessageId, ...describeError(err) });
    } catch (dlqErr) {
      // sem ack: a mensagem volta pra fila e a redrive policy ainda pega
      this.logger.failure("could not move message to DLQ", dlqErr, { reason });
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queues.wagerQueueUrl(),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queues.wagerQueueUrl(),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async sampleDlqDepth(): Promise<void> {
    if (Date.now() - this.lastDlqCheck < 30_000) return;
    this.lastDlqCheck = Date.now();
    try {
      const res = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.queues.deadLetterQueueUrl(),
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      this.metrics.dlqDepth.set(Number(res.Attributes?.ApproximateNumberOfMessages ?? 0));
    } catch {
      // métrica é best-effort
    }
  }
}
