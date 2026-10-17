import { loadEnv, type Env } from "../../src/config/env";

/**
 * Os testes de integração usam Postgres e SQS de verdade (docker compose up
 * postgres localstack). Endereços podem ser trocados por variável de ambiente.
 */
export const BASE_ENV: Record<string, string> = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering",
  SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "error",
  SQS_WAIT_SECONDS: "1",
  SQS_VISIBILITY_TIMEOUT: "5",
  OUTBOX_POLL_MS: "100",
  PENDING_REFERENCE_POLL_MS: "100",
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ ...BASE_ENV, ...overrides });
}
