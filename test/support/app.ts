import type { INestApplication, Provider } from "@nestjs/common";
import type { AppModuleOptions } from "../../src/app.module";
import { createApp } from "../../src/bootstrap";
import { Api } from "./api";
import { testEnv } from "./env";

export interface TestApp {
  app: INestApplication;
  api: Api;
  close(): Promise<void>;
}

/** Sobe a aplicação dentro do processo do teste, numa porta aleatória. */
export async function startTestApp(
  options: {
    env?: Record<string, string>;
    workers?: AppModuleOptions["workers"];
    overrides?: Provider[];
  } = {},
): Promise<TestApp> {
  const env = testEnv({ APP_ROLE: "all", ...options.env });
  const app = await createApp({
    env,
    workers: options.workers ?? { consumer: false, outbox: false, pendingReferences: false },
    overrides: options.overrides,
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    api: new Api(`http://127.0.0.1:${address.port}`),
    close: () => app.close(),
  };
}
