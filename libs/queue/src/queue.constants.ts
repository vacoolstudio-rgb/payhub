import type { JobsOptions } from 'bullmq';

export const QueueName = {
  WebhookDelivery: 'webhook-delivery',
  Reconciliation: 'reconciliation',
  Notification: 'notification',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export interface WebhookDeliveryJob {
  readonly deliveryId: string;
  readonly merchantId: string;
  readonly endpointUrl: string;
  readonly secretRef: string;
  readonly eventType: string;
  readonly eventId: string;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
}

export interface ReconciliationJob {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly currency: string;
}

export interface NotificationJob {
  readonly userId: string;
  readonly channel: 'email' | 'push' | 'sms';
  readonly template: string;
  readonly variables: Record<string, string>;
}

/**
 * Default job policy.
 *
 * `removeOnComplete` with a count rather than `true`: keeping the last few
 * thousand jobs makes "did merchant X get notified?" answerable from Bull
 * Board, while an unbounded completed set is a slow Redis memory leak.
 *
 * `attempts` here is BullMQ's own retry ladder, which is separate from the
 * webhook's business-level attempt counter persisted in Postgres — the queue
 * can lose its state, the delivery record must not.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponentialJitter' },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
};
