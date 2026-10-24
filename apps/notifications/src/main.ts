import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger as PinoLogger } from 'nestjs-pino';
import { type AppConfig, type KafkaConfig, appConfig, kafkaConfig, loadEnv } from '@payhub/config';
import {
  fatalExit,
  installGracefulShutdown,
  startTracing,
  stopTracing,
} from '@payhub/observability';
import { NotificationsModule } from './notifications.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  await startTracing({
    enabled: env.OTEL_ENABLED,
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    environment: env.NODE_ENV,
  });

  /**
   * A hybrid application again: the Kafka consumer does the work, the HTTP
   * server exists so Kubernetes has something to probe and Prometheus has
   * something to scrape. A pure `createMicroservice` would have neither.
   */
  const app = await NestFactory.create(NotificationsModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const config = app.get<AppConfig>(appConfig.KEY);
  const kafka = app.get<KafkaConfig>(kafkaConfig.KEY);
  const logger = new Logger('NotificationsBootstrap');

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.KAFKA,
      options: {
        client: {
          clientId: `${kafka.clientId}-notifications`,
          brokers: kafka.brokers,
          ssl: kafka.ssl,
        },
        // Nest appends `-server` to both ids unless told otherwise. An
        // operator reading this file would then set their lag alert on a
        // group that does not exist and watch it stay reassuringly green,
        // so pin the postfix to empty and let the names mean what they say.
        postfixId: '',
        consumer: {
          // Its own consumer group: this service's offsets are independent
          // of the ledger's, so replaying notifications never replays money.
          groupId: `${kafka.consumerGroup}-notifications`,
          sessionTimeout: 30_000,
          heartbeatInterval: 3_000,
          allowAutoTopicCreation: !config.isProduction,
        },
        run: { autoCommit: true },
        // The envelope is JSON; the transport would otherwise hand us a Buffer.
        parser: { keepBinary: false },
        subscribe: { fromBeginning: false },
      },
    },
    { inheritAppConfig: true },
  );

  // No `enableShutdownHooks()`: it only registers signal listeners, and
  // those would close the socket before the drain below could matter.
  // `app.close()` runs the lifecycle hooks on its own. See
  // apps/api/src/main.ts for the measurement.

  // The shared helper rather than a hand-rolled SIGTERM listener, which is
  // what this was. That version handled only SIGTERM — Ctrl-C went to
  // Node's default and the Kafka consumer never committed its offsets —
  // and it had no watchdog, so an `app.close()` stuck on a consumer
  // rebalance left the pod in Terminating until the orchestrator killed
  // it, with nothing in the logs to say why.
  installGracefulShutdown(app, {
    graceMs: config.shutdownGraceMs,
    drainDelayMs: config.shutdownDrainDelayMs,
    beforeClose: () => stopTracing(),
  });

  await app.startAllMicroservices();
  await app.listen(config.port, '0.0.0.0');

  logger.log(
    `Notifications service consuming ${kafka.brokers.join(',')} as "${kafka.consumerGroup}-notifications"`,
  );
}

bootstrap().catch((error: unknown) => fatalExit('Notifications service failed to start', error));
