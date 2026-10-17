import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  type AppConfig,
  type ObservabilityConfig,
  appConfig,
  observabilityConfig,
} from '@payhub/config';
import { CORRELATION_ID_HEADER, PINO_REDACT_PATHS, type PayHubClsStore } from '@payhub/shared';

/**
 * Structured logging with pino.
 *
 * Three decisions worth defending at review time:
 *
 * 1. **JSON in production, pretty only locally.** Log aggregators parse JSON;
 *    `pino-pretty` costs CPU on the hot path and is a separate process for a
 *    reason.
 * 2. **Correlation id injected from AsyncLocalStorage**, so every line —
 *    including ones written deep inside a service with no request object in
 *    scope — is attributable to a request without threading a logger around.
 * 3. **Redaction at the serialiser level**, not at the call site. Relying on
 *    developers to remember not to log `Authorization` is how tokens end up
 *    in Kibana.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [appConfig.KEY, observabilityConfig.KEY, ClsService],
      useFactory: (
        app: AppConfig,
        observability: ObservabilityConfig,
        cls: ClsService<PayHubClsStore>,
      ) => ({
        pinoHttp: {
          level: observability.logLevel,
          base: {
            service: app.serviceName,
            version: app.serviceVersion,
            env: app.nodeEnv,
            pid: process.pid,
          },
          redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
          genReqId: (req, res) => {
            const existing = req.headers[CORRELATION_ID_HEADER];
            const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
            res.setHeader(CORRELATION_ID_HEADER, id);
            return id;
          },
          /**
           * `mixin`, not `customProps`.
           *
           * `customProps` is a pino-http feature: it decorates logs that
           * belong to an HTTP request and nothing else. Every line
           * written while handling a Kafka message, running a cron or
           * processing a queue job came out with no correlation id at
           * all — which is most of what a payment actually does, and
           * exactly the lines somebody is grepping for at three in the
           * morning. `mixin` runs for every log record the instance
           * emits, whatever started it.
           *
           * It must never throw: a logger that can fail turns a handled
           * error into an unhandled one.
           */
          mixin: () => {
            try {
              if (!cls.isActive()) {
                return {};
              }

              const correlationId = cls.get('correlationId');
              const userId = cls.get('principal')?.id;

              return {
                ...(correlationId ? { correlationId } : {}),
                ...(userId ? { userId } : {}),
              };
            } catch {
              return {};
            }
          },
          // Health and metrics scrapes would otherwise dominate the log volume.
          autoLogging: {
            ignore: (req) =>
              req.url?.startsWith('/health') === true || req.url?.startsWith('/metrics') === true,
          },
          customLogLevel: (_req, res, error) => {
            if (error || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },
          serializers: {
            req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
              remoteAddress: req.remoteAddress,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          // Spread rather than `: undefined` — pino treats an absent
          // `transport` as "log JSON to stdout", which is not the same
          // statement as passing an explicit undefined.
          ...(observability.logPretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { singleLine: true, colorize: true, translateTime: 'HH:MM:ss.l' },
                },
              }
            : {}),
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
