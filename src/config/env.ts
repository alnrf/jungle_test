import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ROLE: z.enum(["api", "worker", "all"]).default("all"),
  INSTANCE_ID: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().default("postgres://wagering:wagering@localhost:5432/wagering"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().default("test"),
  AWS_SECRET_ACCESS_KEY: z.string().default("test"),
  SQS_ENDPOINT: z.string().optional(),
  SQS_WAGER_QUEUE: z.string().default("wager-transactions.fifo"),
  SQS_WAGER_DLQ: z.string().default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE: z.string().default("wagering-events.fifo"),
  SQS_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SQS_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT: z.coerce.number().int().positive().default(30),
  SQS_CONSUMER_NAME: z.string().default("wager-transactions-consumer"),

  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(200),

  PENDING_REFERENCE_POLL_MS: z.coerce.number().int().positive().default(1_000),
  PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().positive().default(2_000),
  PENDING_REFERENCE_MAX_DELAY_MS: z.coerce.number().int().positive().default(5 * 60_000),
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(25_000),

  // usado só nos testes de crash. Nunca ligar fora disso.
  FAULT_CRASH_AFTER_COMMIT: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

export const ENV = Symbol("ENV");
