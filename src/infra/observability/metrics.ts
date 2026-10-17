import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Transações decididas, por kind e status final",
    labelNames: ["kind", "status"] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Entregas repetidas detectadas (inbox ou idempotency key)",
    labelNames: ["source", "layer"] as const,
    registers: [this.registry],
  });

  readonly idempotencyConflicts = new Counter({
    name: "wagering_idempotency_conflicts_total",
    help: "Mesma chave com payload diferente",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retentativas (transação de banco, mensagem SQS, publicação de outbox)",
    labelNames: ["operation", "reason"] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Deadlock, lock timeout, falha de serialização ou version conflict",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: "wagering_dlq_messages_total",
    help: "Mensagens enviadas para a DLQ por este processo",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  readonly dlqDepth = new Gauge({
    name: "wagering_dlq_depth",
    help: "Mensagens visíveis na DLQ (amostrado)",
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: "wagering_outbox_pending",
    help: "Eventos ainda não publicados",
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Idade do evento não publicado mais antigo",
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: "wagering_outbox_published_total",
    help: "Eventos publicados",
    labelNames: ["event_type"] as const,
    registers: [this.registry],
  });

  readonly outboxPublishFailures = new Counter({
    name: "wagering_outbox_publish_failures_total",
    help: "Falhas ao publicar evento (vai ter retry)",
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "Latência do use case de submissão",
    labelNames: ["source", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly pendingReferenceExpired = new Counter({
    name: "wagering_pending_reference_expired_total",
    help: "Transações rejeitadas porque a referência nunca chegou",
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: "wagering_reconciliation_divergences_total",
    help: "Reconciliações em que saldo e ledger não bateram",
    registers: [this.registry],
  });
}
