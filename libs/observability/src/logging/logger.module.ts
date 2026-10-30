import { createRequire } from 'node:module';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import { trace } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import {
  type AppConfig,
  type ObservabilityConfig,
  appConfig,
  observabilityConfig,
} from '@payhub/config';
import {
  CORRELATION_ID_HEADER,
  PINO_REDACT_PATHS,
  type PayHubClsStore,
  redact,
} from '@payhub/shared';

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
          /**
           * Two layers, because the path list cannot reach everything.
           *
           * pino's `*` matches exactly one level, so `*.password`
           * covers `user.password` and nothing else. Measured against
           * this very configuration: a top-level `password` went to
           * the log in plain text, so did one two levels down, and so
           * did a nested request body carrying a password and an
           * `ph_live_` key together. The paths are precise and fast
           * for the shapes they name; they are not a guarantee.
           *
           * `redact()` existed for exactly this and was called by
           * nobody — a recursive walk that masks a sensitive key
           * wherever it appears. Running it as the log formatter is
           * what turns the list into a floor rather than the whole
           * defence. It is bounded by its own depth cap, so a
           * pathological object costs a fixed walk, not an unbounded
           * one.
           */
          redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
          formatters: {
            log: (object: Record<string, unknown>) => redact(object),
          },
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
              const requestId = cls.get('requestId');
              const userId = cls.get('principal')?.id;

              /**
               * The OpenTelemetry ids, when a span is active.
               *
               * Without them the two halves of the story never meet: a
               * slow span in the trace viewer has no path to its log
               * lines, and an error log has no path to the trace that
               * shows where the time went. `correlationId` joins our own
               * services to each other; `traceId` joins them to the
               * trace, and is the id an exported span is actually
               * indexed by.
               */
              const span = trace.getActiveSpan()?.spanContext();

              return {
                ...(correlationId ? { correlationId } : {}),
                // Unique per hop, where the correlation id spans all of
                // them: two log lines with one correlation id and
                // different request ids are two services, not a retry.
                ...(requestId ? { requestId } : {}),
                ...(userId ? { userId } : {}),
                ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
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
          //
          // Asked for *and* installed. `pino-pretty` is a development
          // dependency and is not in the runtime image, so a container
          // started with `LOG_PRETTY=true` died on boot with "unable to
          // determine transport target" — a payments API refusing to
          // start because a log formatter is missing. The flag is a
          // preference about how lines look; it should never be able to
          // stop the service.
          ...(observability.logPretty && prettyAvailable()
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

/**
 * Whether `pino-pretty` can actually be loaded.
 *
 * Resolved rather than assumed: the flag that asks for it and the
 * dependency that provides it live in different files, and only one of
 * them ships in the runtime image.
 */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}
