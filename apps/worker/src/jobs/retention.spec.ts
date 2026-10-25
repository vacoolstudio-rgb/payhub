import { describe, expect, it } from 'vitest';
import {
  DEDUPLICATION_RETENTION_MS,
  DLQ_RETENTION_MS,
  RETRY_RETENTION_MS,
} from '@payhub/messaging';

const DAYS = 24 * 60 * 60 * 1_000;

/**
 * The one relationship between these numbers that has to hold.
 *
 * Exactly-once delivery is at-least-once plus a memory of what has
 * already been seen. The memory has to outlive the broker's, or the
 * guarantee quietly becomes at-least-once again — and nothing fails,
 * nothing logs, a message simply gets processed twice.
 *
 * These were picked independently and drifted: the inbox forgot a
 * message id after fourteen days while the dead-letter topic held the
 * message for thirty. Replaying a dead letter is something a person
 * does after an investigation, which is the delay that retention is
 * *for*, so the gap was not a corner case — it was the main use.
 *
 * A test rather than a comment because the failure is silent. Nothing
 * about a duplicate announces that a retention number moved.
 */
describe('retention windows', () => {
  it('remembers a message id for longer than any topic keeps the message', () => {
    expect(DEDUPLICATION_RETENTION_MS).toBeGreaterThan(DLQ_RETENTION_MS);
    expect(DEDUPLICATION_RETENTION_MS).toBeGreaterThan(RETRY_RETENTION_MS);
  });

  /**
   * The dead-letter topic is the long one, deliberately — it is the only
   * one whose replay is driven by a human timeline.
   */
  it('keeps a dead letter longer than a retry', () => {
    expect(DLQ_RETENTION_MS).toBeGreaterThan(RETRY_RETENTION_MS);
  });

  it('leaves a margin rather than matching the broker exactly', () => {
    // The sweep runs on our clock and the broker expires on its own;
    // equal numbers would make the two race.
    expect(DEDUPLICATION_RETENTION_MS - DLQ_RETENTION_MS).toBeGreaterThanOrEqual(1 * DAYS);
  });

  it('does not keep deduplication records indefinitely', () => {
    // The other direction: this table grows with every message handled,
    // so "outlives the broker" must not become "forever".
    expect(DEDUPLICATION_RETENTION_MS).toBeLessThanOrEqual(90 * DAYS);
  });
});
