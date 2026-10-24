import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { ShutdownState } from './health/shutdown-state.service.js';
import { writeSync } from 'node:fs';

/**
 * Writes straight to fd 2, bypassing the logger.
 *
 * pino buffers and flushes asynchronously, so a `logger.error()` immediately
 * followed by `process.exit()` loses the message — which is precisely the
 * message you need when a process dies at boot. `writeSync` cannot be lost.
 */
function fatal(message: string): void {
  try {
    writeSync(2, `${message}\n`);
  } catch {
    // stderr is gone; there is nothing left to do.
  }
}

/**
 * Reports a fatal startup error and exits.
 *
 * `console.error` writes asynchronously when stderr is a pipe (which it is
 * under Docker, systemd and CI), so `console.error(e); process.exit(1)`
 * reliably loses the message — the one case where you need it most. This
 * writes synchronously first.
 */
export function fatalExit(context: string, error: unknown): never {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  fatal(`[FATAL] ${context}: ${detail}`);
  process.exit(1);
}

export interface ShutdownOptions {
  readonly graceMs: number;
  /**
   * How long to keep serving after readiness starts failing.
   *
   * Removing a pod from a Service is asynchronous — the endpoint is
   * withdrawn and every node rewrites its proxy rules — so for a few
   * seconds after SIGTERM the orchestrator is still sending work to a
   * pod that is on its way out. Closing the socket immediately turns
   * that window into connection errors for whoever is routed there.
   */
  readonly drainDelayMs: number;
  readonly logger?: Logger;
  readonly beforeClose?: () => Promise<void>;
}

/**
 * Graceful shutdown.
 *
 * `app.enableShutdownHooks()` makes Nest call `onModuleDestroy` /
 * `onApplicationShutdown` on SIGTERM, which is how the database pool and the
 * Kafka consumer get to finish their work. Two details that are easy to get
 * wrong:
 *
 * • **PID 1.** `CMD ["node", "dist/main.js"]` makes node PID 1 and it
 *   receives SIGTERM directly. `CMD npm run start` puts a shell (and npm) in
 *   between, neither of which forwards signals, so Docker waits the full
 *   10 s grace period and then SIGKILLs — losing every in-flight request.
 * • **The watchdog below.** If a handler hangs (a consumer stuck on a
 *   rebalance, say) the pod would sit in `Terminating` until the orchestrator
 *   kills it. Exiting ourselves after the grace period keeps deploys fast and
 *   makes the failure visible in the logs.
 */
export function installGracefulShutdown(
  app: INestApplication,
  options: ShutdownOptions,
): void {
  const logger = options.logger ?? new Logger('Shutdown');
  let shuttingDown = false;

  const drain = (reason: string, exitCode: number): void => {
    if (shuttingDown) {
      logger.warn(`${reason} while already draining — forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.log(`${reason}, draining (grace ${options.graceMs}ms)`);

    const watchdog = setTimeout(() => {
      logger.error('Graceful shutdown timed out — exiting hard');
      process.exit(1);
    }, options.graceMs);
    watchdog.unref();

    void (async () => {
      try {
        // Fail readiness, then wait. Measured before this existed:
        // `/health/ready` answered 200 as SIGTERM arrived and the socket
        // refused connections 40 ms later, with no failing probe in
        // between — nothing ever told the load balancer to stop.
        app.get(ShutdownState, { strict: false }).beginDraining();
        logger.log(`Readiness failing; serving for another ${options.drainDelayMs}ms`);
        await delay(options.drainDelayMs);

        await options.beforeClose?.();
        await app.close();
        clearTimeout(watchdog);
        logger.log('Shutdown complete');
        process.exit(exitCode);
      } catch (error) {
        logger.error('Shutdown failed', error instanceof Error ? error.stack : String(error));
        process.exit(1);
      }
    })();
  };

  const onSignal = (signal: NodeJS.Signals): void => drain(`Received ${signal}`, 0);

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  /**
   * An unhandled rejection leaves the process in an unknown state: a
   * promise chain died somewhere with its error unobserved, and whatever
   * it was halfway through is halfway through still.
   *
   * Registering this listener is what makes that survivable — and that is
   * the trap. Since Node 15 the default for an unhandled rejection is to
   * crash; adding a handler silently *replaces* that default. A handler
   * that only logs therefore does the opposite of what it looks like: it
   * keeps a process of unknown integrity in the load balancer, serving
   * payments, forever.
   *
   * So log it (synchronously, because pino's buffer will not survive the
   * exit) and then drain and exit non-zero, which is what the orchestrator
   * is waiting to act on.
   */
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    fatal(`[FATAL] Unhandled rejection: ${detail}`);
    logger.error(`Unhandled rejection: ${detail}`);
    drain('Unhandled rejection', 1);
  });
  process.on('uncaughtException', (error) => {
    fatal(`[FATAL] Uncaught exception: ${error.stack ?? error.message}`);
    logger.error(`Uncaught exception: ${error.message}`, error.stack);
    process.exit(1);
  });
}
