import type { IntegrationEvent, IntegrationEventEnvelope } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  /** O id da mensagem é o próprio eventId: o consumidor deduplica por ele. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // cópia via JSON: o payload tem que ser exatamente o que vai pro broker,
    // sem Date, sem undefined e sem objeto congelado do evento
    const envelope: IntegrationEventEnvelope<unknown> = JSON.parse(JSON.stringify(event.toJSON()));
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      envelope as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
      s.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt ??= at;
    this._nextAttemptAt = undefined;
  }

  /** Backoff exponencial: 1s, 2s, 4s... até 5min. Não desiste: evento confirmado não pode sumir. */
  scheduleRetry(now: Date, error?: string): void {
    this._attempts += 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this._attempts - 1), MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error?.slice(0, 500);
  }
}
