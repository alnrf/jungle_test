import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Injectable } from "@nestjs/common";
import { EventPublisher, SqsEventPublisher } from "../../src/infra/messaging/event-publisher";
import { OutboxRelay } from "../../src/infra/workers/outbox-relay";
import { UnitOfWork } from "../../src/application/ports";
import { ENV, type Env } from "../../src/config/env";
import { AppLogger } from "../../src/infra/observability/logger";
import { Metrics } from "../../src/infra/observability/metrics";
import { Clock } from "../../src/shared/domain/clock";
import type { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { startTestApp, type TestApp } from "../support/app";
import { wagerBody } from "../support/api";
import { TestDb } from "../support/db";
import { QUEUES, TestSqs } from "../support/sqs";
import { sleep } from "../support/wait";

/** Publisher real (SQS) que também registra o que publicou, e pode simular crash. */
@Injectable()
class RecordingPublisher extends EventPublisher {
  static published: string[] = [];
  static crashNext = false;

  constructor(private readonly real: SqsEventPublisher) {
    super();
  }

  async publish(messages: OutboxMessage[]): Promise<Map<string, string>> {
    // um pouco de latência deixa a disputa entre relays mais realista
    await sleep(20);
    const failed = await this.real.publish(messages);
    for (const m of messages) if (!failed.has(m.id)) RecordingPublisher.published.push(m.id);
    if (RecordingPublisher.crashNext) {
      RecordingPublisher.crashNext = false;
      // publicou no broker mas "morreu" antes do commit
      throw new Error("simulated crash after publish");
    }
    return failed;
  }
}

const db = new TestDb();
const sqs = new TestSqs();
let t: TestApp;

beforeAll(async () => {
  await sqs.purgeAll();
  t = await startTestApp({
    env: { OUTBOX_BATCH_SIZE: "5" },
    overrides: [SqsEventPublisher, { provide: EventPublisher, useClass: RecordingPublisher }],
  });
  // isola o teste de eventos deixados por outros testes
  await db.query(`update outbox_messages set published_at = now() where published_at is null`);
});

afterAll(async () => {
  await t.close();
  await db.close();
});

/** Relay montado à mão, sem o loop: o teste decide quando cada um roda. */
function relay(): OutboxRelay {
  const get = <T>(token: unknown) => t.app.get<T>(token as never, { strict: false });
  return new OutboxRelay(
    get(UnitOfWork),
    get(EventPublisher),
    get(Clock),
    get(Metrics),
    get(AppLogger),
    get<Env>(ENV),
  );
}

async function pendingIds(): Promise<string[]> {
  const rows = await db.query<{ id: string }>(`select id from outbox_messages where published_at is null`);
  return rows.map((r) => r.id);
}

describe("outbox", () => {
  test("dois publishers concorrentes não publicam o mesmo evento ao mesmo tempo e não perdem nenhum", async () => {
    RecordingPublisher.published = [];
    const wallet = await t.api.createWallet("1000.00");
    for (let i = 0; i < 12; i++) await t.api.submit(wagerBody(wallet, "BET", "1.00"));
    const expected = await pendingIds();
    expect(expected.length).toBeGreaterThanOrEqual(24);

    const relayA = relay();
    const relayB = relay();
    while ((await pendingIds()).length > 0) {
      await Promise.all([relayA.publishBatch(), relayB.publishBatch()]);
    }

    const published = RecordingPublisher.published.filter((id) => expected.includes(id));
    expect(new Set(published).size).toBe(expected.length);
    // SKIP LOCKED: sem crash, ninguém publica duas vezes
    expect(published.length).toBe(expected.length);
  });

  test("processo morre depois de publicar e antes do commit: outro relay republica, consumidor deduplica por eventId", async () => {
    RecordingPublisher.published = [];
    await sqs.drain(QUEUES.events, 1_500);
    const wallet = await t.api.createWallet("100.00");
    await t.api.submit(wagerBody(wallet, "BET", "1.00"));
    const expected = await pendingIds();

    RecordingPublisher.crashNext = true;
    await relay().publishBatch().catch(() => undefined);
    // commit não aconteceu: continua pendente
    expect((await pendingIds()).sort()).toEqual(expected.sort());

    // "outra instância" assume
    while ((await pendingIds()).length > 0) await relay().publishBatch();

    const counts = new Map<string, number>();
    for (const id of RecordingPublisher.published) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const id of expected) expect(counts.get(id)).toBeGreaterThanOrEqual(2);

    // do lado do consumidor: deduplicar por eventId resolve
    const received = await sqs.drain(QUEUES.events, 3_000);
    const eventIds = received.map((m) => JSON.parse(m.Body!).eventId as string).filter((id) => expected.includes(id));
    expect(new Set(eventIds)).toEqual(new Set(expected));
  });
});

