import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import {
  type AppConfig,
  type RedisConfig,
  appConfig,
  loadEnv,
  redisConfig,
} from '@payhub/config';
import {
  fatalExit,
  installGracefulShutdown,
  startTracing,
  stopTracing,
} from '@payhub/observability';
import { AppModule } from './app.module.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';

async function bootstrap(): Promise<void> {
  // Instrumentation first: auto-instrumentation patches pg/ioredis/http on
  // import, so starting it after the module graph is built silently loses
  // every span.
  const env = loadEnv();
  await startTracing({
    enabled: env.OTEL_ENABLED,
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    environment: env.NODE_ENV,
  });

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Raw body is needed to verify inbound provider webhook signatures: the
    // HMAC covers the exact bytes, and JSON.parse → JSON.stringify does not
    // round-trip them.
    rawBody: true,
  });

  app.useLogger(app.get(PinoLogger));

  const config = app.get<AppConfig>(appConfig.KEY);
  const redis = app.get<RedisConfig>(redisConfig.KEY);
  const logger = new Logger('ApiBootstrap');

  // --- HTTP hardening -----------------------------------------------------
  app.use(
    helmet({
      // The API serves JSON, not HTML; a restrictive CSP costs nothing and
      // protects the Swagger page that is served from the same origin.
      // Omitted rather than set to `undefined` in production: helmet reads
      // an absent key as "use the default", and passing an explicit
      // undefined only looks like the same thing.
      ...(config.isProduction ? {} : { contentSecurityPolicy: false as const }),
      crossOriginEmbedderPolicy: false,
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  if (config.trustProxy) {
    // Without this, `req.ip` is the load balancer and every rate limit is
    // shared by the whole internet.
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-api-key',
      'idempotency-key',
      'x-correlation-id',
    ],
    exposedHeaders: ['x-correlation-id', 'x-request-id', 'idempotent-replay', 'retry-after'],
    maxAge: 86_400,
  });

  app.setGlobalPrefix(config.globalPrefix, {
    exclude: ['health/(.*)', 'metrics', 'graphql'],
  });

  // URI versioning: `/api/v1/payments`. Chosen over header versioning
  // because it is visible in logs, cacheable, and trivially routable at the
  // ingress when v2 eventually ships behind a different deployment.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties and reject requests that send them: a
      // silently ignored `{"amount": 1, "ammount": 1000}` is a bug waiting
      // to be exploited.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  // --- WebSocket ----------------------------------------------------------
  const ioAdapter = new RedisIoAdapter(app, redis.url, `${redis.keyPrefix}:api`);
  await ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);

  // --- OpenAPI ------------------------------------------------------------
  if (!config.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('PayHub API')
        .setDescription(
          'Wallets, double-entry ledger and payments. REST for commands, GraphQL (/graphql) for the dashboard read model, WebSocket (/realtime) for live updates, SSE for the assistant stream.',
        )
        .setVersion(config.serviceVersion)
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
        .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'apiKey')
        .addServer(`http://localhost:${config.port}`, 'local')
        .build(),
      { operationIdFactory: (_controller, method) => method },
    );

    SwaggerModule.setup(`${config.globalPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
    });
  }

  app.enableShutdownHooks();
  installGracefulShutdown(app, {
    graceMs: config.shutdownGraceMs,
    beforeClose: () => stopTracing(),
  });

  await app.listen(config.port, '0.0.0.0');

  logger.log(`PayHub API listening on :${config.port}`);
  logger.log(`  REST      http://localhost:${config.port}/${config.globalPrefix}/v1`);
  logger.log(`  GraphQL   http://localhost:${config.port}/graphql`);
  logger.log(`  WebSocket ws://localhost:${config.port}/realtime`);
  logger.log(`  SSE       http://localhost:${config.port}/${config.globalPrefix}/v1/assistant/stream`);
  if (!config.isProduction) {
    logger.log(`  Docs      http://localhost:${config.port}/${config.globalPrefix}/docs`);
  }
}

bootstrap().catch((error: unknown) => fatalExit('API failed to start', error));
