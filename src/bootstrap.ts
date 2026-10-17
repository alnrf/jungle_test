import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule, type AppModuleOptions } from "./app.module";
import { AppLogger } from "./infra/observability/logger";
import { correlationMiddleware } from "./interfaces/http/correlation";

export async function createApp(options: AppModuleOptions): Promise<NestExpressApplication> {
  const { env } = options;
  AppLogger.configure(env.LOG_LEVEL, env.INSTANCE_ID);
  const logger = new AppLogger();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), {
    logger,
    abortOnError: false,
  });
  app.disable("x-powered-by");
  app.use(correlationMiddleware(logger));
  app.useBodyParser("json", { limit: "64kb" });
  app.enableShutdownHooks();
  return app;
}
