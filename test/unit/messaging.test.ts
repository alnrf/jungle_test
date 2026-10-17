import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../src/messaging/domain/events";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/messaging/domain/outbox-message";
import { brl, NOW, wallet } from "./helpers";

const ctx = { correlationId: "corr-1", causationId: "msg-1", occurredAt: NOW };

describe("eventos", () => {
  test("envelope serializa Money como string e leva eventType/version do tipo", () => {
    const w = wallet();
    const entry = w.debit("tx-1", brl("25.00"), NOW);
    const json = WalletBalanceChanged.from(w, entry, ctx).toJSON();

    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(NOW.toISOString());
    expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(json.data.balanceAfter).toEqual({ amount: "75.00", currency: "BRL" });
    expect(json.data.walletVersion).toBe(2);
    expect(JSON.stringify(json)).not.toContain("cents");
  });
});

describe("OutboxMessage", () => {
  const message = () => {
    const w = wallet();
    return OutboxMessage.enqueue(WalletBalanceChanged.from(w, w.debit("tx-1", brl("1.00"), NOW), ctx));
  };

  test("nasce pendente e devida", () => {
    const m = message();
    expect(m.isPending()).toBe(true);
    expect(m.isDue(NOW)).toBe(true);
  });

  test("retry com backoff exponencial limitado", () => {
    const m = message();
    m.scheduleRetry(NOW, "boom");
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1_000);
    expect(m.isDue(NOW)).toBe(false);
    m.scheduleRetry(NOW);
    expect(m.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 2_000);
    for (let i = 0; i < 20; i++) m.scheduleRetry(NOW);
    expect(m.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 5 * 60_000);
  });

  test("publicada não é mais devida", () => {
    const m = message();
    m.markPublished(NOW);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date(NOW.getTime() + 60_000))).toBe(false);
  });
});

describe("InboxMessage", () => {
  test("markProcessed é idempotente", () => {
    const inbox = InboxMessage.receive({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    inbox.markProcessed(new Date(NOW.getTime() + 1000));
    expect(inbox.processedAt).toEqual(NOW);
  });
});
