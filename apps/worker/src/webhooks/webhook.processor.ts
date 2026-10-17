import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { type WorkerConfig, workerConfig } from '@payhub/config';
import { MetricsService } from '@payhub/observability';
import { QueueName, type WebhookDeliveryJob } from '@payhub/queue';
import { CircuitBreaker, classifyHost, signWebhook } from '@payhub/shared';
import { WebhookDeliveryRepository } from './webhook-delivery.repository.js';

/**
 * Delivers signed webhooks to merchants.
 *
 * Why BullMQ and not "just POST it in the request handler": a merchant
 * endpoint that is slow or down must not slow down or fail our API, the
 * retry schedule has to survive a pod restart, and operations needs to see
 * what is stuck. All three are queue properties.
 *
 * Retry policy lives in BullMQ (`attempts` + `backoff`), while the durable
 * record of what happened lives in Postgres — the queue is a scheduler, not
 * an audit log.
 */
@Processor(QueueName.WebhookDelivery, {
  // Concurrency is per worker process. Ten in-flight HTTP calls per pod
  // keeps the event loop busy without turning a slow merchant into a
  // memory problem.
  concurrency: 10,
  limiter: { max: 100, duration: 1_000 },
})
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  /**
   * One breaker per endpoint host. A single merchant whose endpoint has
   * been returning 500s for an hour should stop consuming worker slots —
   * without this, a big merchant's outage starves everybody else's
   * deliveries.
   */
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly lastUsed = new Map<string, number>();

  private static readonly MAX_BREAKERS = 1_000;
  private static readonly BREAKER_IDLE_MS = 60 * 60 * 1_000;

  constructor(
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly metrics: MetricsService,
    @Inject(workerConfig.KEY) private readonly config: WorkerConfig,
  ) {
    super();
  }

  async process(job: Job<WebhookDeliveryJob>): Promise<{ statusCode: number }> {
    const { data } = job;
    const startedAt = Date.now();

    await this.assertPublicDestination(data.deliveryId, data.endpointUrl);

    const breaker = this.breakerFor(data.endpointUrl);

    try {
      const response = await breaker.execute(() =>
        this.post(data.endpointUrl, data.payload, data.secretRef, job.attemptsMade + 1),
      );

      const durationMs = Date.now() - startedAt;

      // 2xx is success. Everything else is a failure, but only some of them
      // are worth retrying.
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await this.deliveries.markAttempt(data.deliveryId, {
          status: 'delivered',
          statusCode: response.statusCode,
          responseBody: response.body,
          durationMs,
        });

        this.metrics.webhookDeliveries.inc({
          outcome: 'delivered',
          status_code: String(response.statusCode),
        });

        return { statusCode: response.statusCode };
      }

      const retryable = isRetryableStatus(response.statusCode);

      await this.deliveries.markAttempt(data.deliveryId, {
        status: retryable ? 'pending' : 'failed',
        statusCode: response.statusCode,
        responseBody: response.body,
        error: `HTTP ${response.statusCode}`,
        durationMs,
        nextAttemptAt: retryable ? new Date(Date.now() + 60_000) : null,
      });

      this.metrics.webhookDeliveries.inc({
        outcome: retryable ? 'retry' : 'failed',
        status_code: String(response.statusCode),
      });

      if (!retryable) {
        // 4xx means the merchant rejected the payload; retrying eight times
        // just wastes their capacity and ours.
        throw new UnrecoverableError(
          `Merchant rejected the webhook with ${response.statusCode}`,
        );
      }

      throw new Error(`Webhook returned ${response.statusCode}`);
    } catch (error) {
      if (error instanceof UnrecoverableError) {
        throw error;
      }

      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? this.config.webhookMaxAttempts);

      await this.deliveries.markAttempt(data.deliveryId, {
        status: exhausted ? 'dead' : 'pending',
        error: message,
        durationMs,
        nextAttemptAt: exhausted ? null : new Date(Date.now() + 60_000),
      });

      this.metrics.webhookDeliveries.inc({
        outcome: exhausted ? 'dead' : 'retry',
        status_code: '0',
      });

      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<WebhookDeliveryJob> | undefined, error: Error): void {
    this.logger.warn(
      `Webhook ${job?.data.deliveryId ?? 'unknown'} attempt ${job?.attemptsMade ?? '?'} failed: ${error.message}`,
    );
  }

  /**
   * A stalled job is one whose worker died mid-processing: BullMQ notices
   * the missing heartbeat and hands it to somebody else. Logging it is how
   * you discover an OOM-killed pod before the merchant does.
   */
  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.error(`Webhook job ${jobId} stalled — the previous worker died mid-delivery`);
  }

  /**
   * Re-checks where this URL actually points, immediately before connecting.
   *
   * `WebhookEndpoint` validated the URL when the merchant saved it, but
   * that check sees a string: nothing stops `hooks.example.com` from
   * pointing at `10.0.0.1` afterwards, or from answering differently on
   * each lookup. A stored rule that is never re-enforced is not a control.
   *
   * `UnrecoverableError` because no number of retries will make an
   * internal address public, and because every retry is another request
   * actually sent inside the network.
   */
  private async assertPublicDestination(deliveryId: string, url: string): Promise<void> {
    // `hostname`, not `host`: the latter carries the port, which is not
    // part of an address and which no resolver will accept.
    const host = safeHostname(url);

    const classification = await classifyHost(host);

    // `unresolved` is not a verdict. A resolver blip must not bury a
    // delivery as unrecoverable — let it through and let the request fail
    // the way any network error does, with the ordinary retry schedule.
    if (classification !== 'private') {
      return;
    }

    this.logger.error(`Refusing webhook to ${host}: resolves to a non-public address`);

    await this.deliveries.markAttempt(deliveryId, {
      status: 'failed',
      error: 'Endpoint resolves to a non-public address',
      durationMs: 0,
    });
    this.metrics.webhookDeliveries.inc({ outcome: 'blocked', status_code: '0' });

    throw new UnrecoverableError('Webhook endpoint resolves to a non-public address');
  }

  /**
   * One breaker per host, with the idle ones evicted.
   *
   * The map used to only ever grow: one entry per distinct merchant host,
   * each holding a 50-slot ring buffer, never removed. On a long-running
   * worker that is an unbounded cache keyed by attacker-chosen data.
   */
  private breakerFor(url: string): CircuitBreaker {
    const host = safeHost(url);
    let breaker = this.breakers.get(host);

    if (!breaker) {
      breaker = new CircuitBreaker({
        name: `webhook:${host}`,
        // A merchant endpoint is allowed to be flaky; it is sustained
        // failure across a window that should stop consuming worker slots.
        windowSize: 50,
        failureRateThreshold: 0.6,
        minimumCalls: 20,
        resetTimeoutMs: 60_000,
        successThreshold: 2,
      });
      this.evictIdleBreakers();
      this.breakers.set(host, breaker);
    }

    this.lastUsed.set(host, Date.now());
    return breaker;
  }

  /** Drops breakers no delivery has touched for an hour. */
  private evictIdleBreakers(): void {
    if (this.breakers.size < WebhookProcessor.MAX_BREAKERS) {
      return;
    }

    const cutoff = Date.now() - WebhookProcessor.BREAKER_IDLE_MS;
    for (const [host, touchedAt] of this.lastUsed) {
      if (touchedAt < cutoff) {
        this.breakers.delete(host);
        this.lastUsed.delete(host);
      }
    }

    // Still full of live hosts: drop the coldest rather than grow forever.
    if (this.breakers.size >= WebhookProcessor.MAX_BREAKERS) {
      const coldest = [...this.lastUsed.entries()].sort((a, b) => a[1] - b[1])[0];
      if (coldest) {
        this.breakers.delete(coldest[0]);
        this.lastUsed.delete(coldest[0]);
      }
    }
  }

  /**
   * Signed POST with a hard timeout.
   *
   * The signature covers `timestamp.payload`, so a captured request cannot
   * be replayed outside the merchant's tolerance window. Merchants verify it
   * with the secret they received once when configuring the endpoint.
   */
  private async post(
    url: string,
    payload: Record<string, unknown>,
    secret: string,
    attempt: number,
  ): Promise<{ statusCode: number; body: string }> {
    const body = JSON.stringify(payload);
    const timestampSec = Math.floor(Date.now() / 1_000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'PayHub-Webhooks/1.0',
        'payhub-signature': signWebhook(body, secret, timestampSec),
        'payhub-delivery-attempt': String(attempt),
      },
      body,
      // A merchant that never closes the connection must not pin a worker
      // slot forever.
      signal: AbortSignal.timeout(this.config.webhookTimeoutMs),
      redirect: 'manual',
    });

    // Read at most 8 KiB: a merchant returning a 50 MB error page must not
    // be able to exhaust the worker's memory.
    const text = await readCapped(response, 8_192);

    return { statusCode: response.status, body: text };
  }
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  while (received < limit) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      received += value.byteLength;
    }
  }

  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    .subarray(0, limit)
    .toString('utf8');
}

/**
 * 408, 429 and 5xx are transient; the rest of the 4xx range means the
 * request itself is wrong and will be wrong again next time.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Host *and port* — the identity of an endpoint, used to key its breaker. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

/** Host only — what DNS can actually be asked about. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}
