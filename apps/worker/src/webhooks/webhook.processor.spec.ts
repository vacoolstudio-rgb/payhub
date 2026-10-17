import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError, type Job } from 'bullmq';
import { workerConfig } from '@payhub/config';
import { MetricsService } from '@payhub/observability';
import { verifyWebhookSignature } from '@payhub/shared';
import type { WebhookDeliveryJob } from '@payhub/queue';
import { WebhookDeliveryRepository } from './webhook-delivery.repository.js';
import { WebhookProcessor } from './webhook.processor.js';

const SECRET = 'whsec_test';

function makeJob(attemptsMade = 0, endpointUrl = 'https://merchant.example/hooks'): Job<WebhookDeliveryJob> {
  return {
    attemptsMade,
    opts: { attempts: 8 },
    data: {
      deliveryId: 'delivery-1',
      merchantId: 'merchant-1',
      endpointUrl,
      secretRef: SECRET,
      eventType: 'payment.captured.v1',
      eventId: 'event-1',
      payload: { id: 'event-1', data: { amount: '10000' } },
      attempt: attemptsMade,
    },
  } as unknown as Job<WebhookDeliveryJob>;
}

function respond(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('WebhookProcessor', () => {
  let processor: WebhookProcessor;
  let deliveries: { markAttempt: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    deliveries = { markAttempt: vi.fn().mockResolvedValue(undefined) };
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookProcessor,
        { provide: WebhookDeliveryRepository, useValue: deliveries },
        {
          provide: MetricsService,
          useValue: { webhookDeliveries: { inc: vi.fn() } },
        },
        {
          provide: workerConfig.KEY,
          useValue: {
            webhookMaxAttempts: 8,
            webhookTimeoutMs: 5_000,
            webhookConcurrency: 10,
            outboxPollIntervalMs: 500,
            outboxBatchSize: 200,
            reconciliationCron: '*/5 * * * *',
          },
        },
      ],
    }).compile();

    processor = moduleRef.get(WebhookProcessor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('delivers and records a 200', async () => {
    fetchMock.mockResolvedValue(respond(200, 'ok'));

    const result = await processor.process(makeJob());

    expect(result).toEqual({ statusCode: 200 });
    expect(deliveries.markAttempt).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ status: 'delivered', statusCode: 200 }),
    );
  });

  /** The merchant has to be able to verify the call really came from us. */
  it('signs the exact bytes it sends', async () => {
    fetchMock.mockResolvedValue(respond(200));

    await processor.process(makeJob());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;

    expect(verifyWebhookSignature(headers['payhub-signature']!, body, SECRET)).toBe(true);
    expect(verifyWebhookSignature(headers['payhub-signature']!, `${body} `, SECRET)).toBe(false);
  });

  it('tells the receiver which attempt this is', async () => {
    fetchMock.mockResolvedValue(respond(200));

    await processor.process(makeJob(2));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['payhub-delivery-attempt']).toBe('3');
  });

  /**
   * A 4xx means the merchant rejected the payload. Retrying it eight times
   * burns their capacity and ours to produce the same answer.
   */
  it.each([400, 401, 403, 404, 422])('does not retry a %i', async (status) => {
    fetchMock.mockResolvedValue(respond(status));

    await expect(processor.process(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(deliveries.markAttempt).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it.each([408, 429, 500, 502, 503])('retries a %i', async (status) => {
    fetchMock.mockResolvedValue(respond(status));

    await expect(processor.process(makeJob())).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(deliveries.markAttempt).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ status: 'pending', statusCode: status }),
    );
  });

  it('buries the delivery once the attempts are exhausted', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(processor.process(makeJob(7))).rejects.toThrow('ECONNREFUSED');
    expect(deliveries.markAttempt).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ status: 'dead' }),
    );
  });

  it('schedules another attempt while retries remain', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(processor.process(makeJob(1))).rejects.toThrow();

    const [, update] = deliveries.markAttempt.mock.calls[0] as [string, { status: string; nextAttemptAt: Date }];
    expect(update.status).toBe('pending');
    expect(update.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  /** A merchant returning a huge error page must not exhaust worker memory. */
  it('caps how much of the response body it keeps', async () => {
    fetchMock.mockResolvedValue(respond(500, 'x'.repeat(100_000)));

    await expect(processor.process(makeJob())).rejects.toThrow();

    const [, update] = deliveries.markAttempt.mock.calls[0] as [string, { responseBody?: string }];
    expect((update.responseBody ?? '').length).toBeLessThanOrEqual(8_192);
  });

  it('does not follow redirects, which could point anywhere', async () => {
    fetchMock.mockResolvedValue(respond(200));

    await processor.process(makeJob());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('manual');
  });

  /**
   * Regression: the endpoint was validated when the merchant saved it,
   * which checks a string. A name that resolves inward — by changing its
   * answer, or by having always pointed there — reached `fetch` with a
   * signed POST from inside the network.
   */
  describe('destination re-check', () => {
    it('refuses to deliver to a name that resolves to a private address', async () => {
      fetchMock.mockResolvedValue(respond(200));

      await expect(
        processor.process(makeJob(0, 'https://localhost:9999/hook')),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      // The point is that the request is never made at all.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not retry a blocked destination', async () => {
      await processor.process(makeJob(0, 'https://localhost:9999/hook')).catch(() => undefined);

      expect(deliveries.markAttempt).toHaveBeenCalledWith(
        'delivery-1',
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('delivers normally to a public destination', async () => {
      fetchMock.mockResolvedValue(respond(200));

      await expect(processor.process(makeJob())).resolves.toEqual({ statusCode: 200 });
    });
  });

  it('opens the circuit for an endpoint that keeps failing', async () => {
    fetchMock.mockRejectedValue(new Error('down'));

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await processor.process(makeJob()).catch(() => undefined);
    }

    const callsBefore = fetchMock.mock.calls.length;
    await processor.process(makeJob()).catch(() => undefined);

    // Once open, the breaker answers without touching the network at all.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
