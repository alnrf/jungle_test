import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { UnitOfWork } from "./application/ports";
import { ReferenceRetryPolicy } from "./application/reference-retry-policy";
import { ResolvePendingReferences } from "./application/wager/resolve-pending-references";
import { SubmitWagerTransaction } from "./application/wager/submit-wager-transaction";
import { WagerSettler } from "./application/wager/wager-settler";
import { CreateWallet } from "./application/wallet/create-wallet";
import { ReconcileWallet } from "./application/wallet/reconcile-wallet";
import { WalletQueries } from "./application/wallet/wallet-queries";
import { ENV, type Env } from "./config/env";
import { MikroOrmUnitOfWork } from "./infra/database/mikro-orm-unit-of-work";
import { buildOrmConfig } from "./infra/database/mikro-orm.config";
import { EventPublisher, SqsEventPublisher } from "./infra/messaging/event-publisher";
import { createSqsClient, SqsQueues } from "./infra/messaging/sqs";
import { AppLogger } from "./infra/observability/logger";
import { Metrics } from "./infra/observability/metrics";
import { OutboxRelay } from "./infra/workers/outbox-relay";
import { PendingReferenceWorker } from "./infra/workers/pending-reference-worker";
import { WagerQueueConsumer } from "./infra/workers/wager-queue-consumer";
import { NoAuthProviderIdentity, ProviderAuthGuard, ProviderIdentityPort } from "./interfaces/http/auth";
import { HttpErrorFilter } from "./interfaces/http/error-filter";
import { HealthController } from "./interfaces/http/health.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";
import { Clock, SystemClock } from "./shared/domain/clock";

export interface AppModuleOptions {
  env: Env;
  /** Liga/desliga os workers independente do APP_ROLE (os testes usam). */
  workers?: { consumer?: boolean; outbox?: boolean; pendingReferences?: boolean };
  overrides?: Provider[];
}

/**
 * APP_ROLE:
 *  - api:    HTTP de negócio + health
 *  - worker: consumer SQS, relay da outbox, worker de referências + health
 *  - all:    tudo junto (dev local)
 */
@Module({})
export class AppModule {
  static forRoot({ env, workers, overrides = [] }: AppModuleOptions): DynamicModule {
    const isApi = env.APP_ROLE !== "worker";
    const isWorker = env.APP_ROLE !== "api";

    const workerProviders: Type[] = [];
    if (workers?.consumer ?? isWorker) workerProviders.push(WagerQueueConsumer);
    if (workers?.outbox ?? isWorker) workerProviders.push(OutboxRelay);
    if (workers?.pendingReferences ?? isWorker) workerProviders.push(PendingReferenceWorker);

    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot({ ...buildOrmConfig(env), registerRequestContext: false })],
      controllers: [HealthController, ...(isApi ? [WalletsController, WageringController] : [])],
      providers: [
        { provide: ENV, useValue: env },
        { provide: Clock, useClass: SystemClock },
        { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
        { provide: SQSClient, useFactory: () => createSqsClient(env) },
        { provide: EventPublisher, useClass: SqsEventPublisher },
        { provide: ProviderIdentityPort, useClass: NoAuthProviderIdentity },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        AppLogger,
        Metrics,
        SqsQueues,
        ProviderAuthGuard,
        ReferenceRetryPolicy,
        WagerSettler,
        SubmitWagerTransaction,
        ResolvePendingReferences,
        CreateWallet,
        WalletQueries,
        ReconcileWallet,
        ...workerProviders,
        ...overrides,
      ],
      exports: [UnitOfWork, SubmitWagerTransaction, Metrics],
    };
  }
}
