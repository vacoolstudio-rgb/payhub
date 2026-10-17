import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger as PinoLogger } from 'nestjs-pino';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AppConfig,
  type GrpcConfig,
  type ObservabilityConfig,
  appConfig,
  grpcConfig,
  loadEnv,
  observabilityConfig,
} from '@payhub/config';
import {
  fatalExit,
  installGracefulShutdown,
  startTracing,
  stopTracing,
} from '@payhub/observability';
import { LedgerModule } from './ledger.module.js';

const here = dirname(fileURLToPath(import.meta.url));

async function bootstrap(): Promise<void> {
  // Tracing must be started before the application graph is built, so the
  // auto-instrumentation can patch pg/ioredis/kafkajs before they are used.
  const env = loadEnv();
  await startTracing({
    enabled: env.OTEL_ENABLED,
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    environment: env.NODE_ENV,
  });

  const app = await NestFactory.create(LedgerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const config = app.get<AppConfig>(appConfig.KEY);
  const grpc = app.get<GrpcConfig>(grpcConfig.KEY);
  const observability = app.get<ObservabilityConfig>(observabilityConfig.KEY);
  const logger = new Logger('LedgerBootstrap');

  /**
   * Hybrid application: an HTTP server for probes and metrics plus a gRPC
   * microservice for the synchronous read API. One process, two transports —
   * which is why the HTTP port stays internal and only `/health` and
   * `/metrics` live on it.
   */
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        package: 'payhub.ledger.v1',
        // `../proto` resolves identically from `apps/ledger/src` (dev) and
        // `dist/apps/ledger/src` (build), because the build copies the
        // .proto files alongside the compiled output.
        protoPath: join(here, '../proto/ledger.proto'),
        url: grpc.listenUrl,
        loader: { keepCase: false, longs: String, defaults: true, oneofs: true },
        maxReceiveMessageLength: 4 * 1024 * 1024,
      },
    },
    { inheritAppConfig: true },
  );

  app.enableShutdownHooks();
  installGracefulShutdown(app, {
    graceMs: config.shutdownGraceMs,
    beforeClose: () => stopTracing(),
  });

  await app.startAllMicroservices();
  await app.listen(config.port, '0.0.0.0');

  logger.log(`Ledger service listening — gRPC ${grpc.listenUrl}, HTTP :${config.port}`);
  logger.log(
    `Tracing ${observability.otelEnabled ? 'on' : 'off'}, metrics ${
      observability.metricsEnabled ? 'on' : 'off'
    }`,
  );
}

bootstrap().catch((error: unknown) => fatalExit('Ledger failed to start', error));
