import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { type AppConfig, appConfig, loadEnv } from '@payhub/config';
import {
  fatalExit,
  installGracefulShutdown,
  startTracing,
  stopTracing,
} from '@payhub/observability';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  await startTracing({
    enabled: env.OTEL_ENABLED,
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    environment: env.NODE_ENV,
  });

  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const config = app.get<AppConfig>(appConfig.KEY);
  const logger = new Logger('WorkerBootstrap');

  /**
   * The worker serves HTTP too, but only for probes, metrics and Bull Board.
   * A background worker with no readiness endpoint is invisible to the
   * orchestrator: it would be restarted on a whim and never drain cleanly.
   */

  // No `enableShutdownHooks()`: it only registers signal listeners, and
  // those would close the socket before the drain below could matter.
  // `app.close()` runs the lifecycle hooks on its own. See
  // apps/api/src/main.ts for the measurement.
  installGracefulShutdown(app, {
    graceMs: config.shutdownGraceMs,
    drainDelayMs: config.shutdownDrainDelayMs,
    beforeClose: () => stopTracing(),
  });

  await app.listen(config.port, '0.0.0.0');

  logger.log(`PayHub worker running (admin+probes on :${config.port})`);
  logger.log(`  Queues    http://localhost:${config.port}/admin/queues`);
  logger.log('  Jobs      outbox relay, webhook delivery, payment expiry, retention');
}

bootstrap().catch((error: unknown) => fatalExit('Worker failed to start', error));
