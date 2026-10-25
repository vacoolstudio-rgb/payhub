import { Global, Module, type DynamicModule } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { CORRELATION_ID_HEADER } from '@payhub/shared';
import { HealthController } from './health/health.controller.js';
import { OutboxHealthIndicator } from './health/outbox.health.js';
import { RedisHealthIndicator } from './health/redis.health.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { HttpMetricsMiddleware } from './metrics/http-metrics.middleware.js';
import { MetricsService } from './metrics/metrics.service.js';
import { TransactionMetricsObserver } from './metrics/transaction-metrics.observer.js';
import { TRANSACTION_OBSERVER } from '@payhub/persistence';
import { LoggerModule } from './logging/logger.module.js';
import {
  DEFAULT_HEALTH_DEPENDENCIES,
  HEALTH_DEPENDENCIES,
  type HealthDependency,
} from './health/health.dependencies.js';
import { ShutdownState } from './health/shutdown-state.service.js';
import { FAILURE_OBSERVER } from '@payhub/kernel';
import { FailureMetricsObserver } from './metrics/failure-metrics.observer.js';

/**
 * Cross-cutting observability: context propagation, logging, metrics, health.
 *
 * `ClsModule` is configured here and marked global because *everything* down
 * the stack (logger, repositories, Kafka producer) reads the correlation id
 * from it.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: { headers: Record<string, string | string[] | undefined> }) => {
          const incoming = req.headers[CORRELATION_ID_HEADER];
          return (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
        },
        setup: (cls, req: { headers: Record<string, string | string[] | undefined> }) => {
          cls.set('correlationId', cls.getId());
          cls.set('requestId', randomUUID());
          cls.set('startedAt', Date.now());
          const key = req.headers['idempotency-key'];
          if (typeof key === 'string') {
            cls.set('idempotencyKey', key);
          }
        },
      },
    }),
    LoggerModule,
    TerminusModule.forRoot({ errorLogStyle: 'pretty' }),
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    MetricsService,
    HttpMetricsMiddleware,
    // Lets `TransactionManager` report its timings without persistence
    // having to import this library back.
    TransactionMetricsObserver,
    { provide: TRANSACTION_OBSERVER, useExisting: TransactionMetricsObserver },
    FailureMetricsObserver,
    { provide: FAILURE_OBSERVER, useExisting: FailureMetricsObserver },
    RedisHealthIndicator,
    OutboxHealthIndicator,
    ShutdownState,
    { provide: HEALTH_DEPENDENCIES, useValue: new Set(DEFAULT_HEALTH_DEPENDENCIES) },
  ],
  exports: [
    FAILURE_OBSERVER,
    ShutdownState,
    ClsModule,
    LoggerModule,
    TerminusModule,
    MetricsService,
    HttpMetricsMiddleware,
    TRANSACTION_OBSERVER,
  ],
})
export class ObservabilityModule {
  /**
   * Imports observability with an explicit dependency set for the health
   * probes. A service with no database must say so, or its readiness probe
   * reports down forever — see {@link HealthDependency}.
   */
  static forRoot(options: { health: readonly HealthDependency[] }): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [{ provide: HEALTH_DEPENDENCIES, useValue: new Set(options.health) }],
      exports: [HEALTH_DEPENDENCIES],
    };
  }
}
