export const FAILURE_OBSERVER = Symbol.for('payhub:FailureObserver');

/**
 * A failure that was deliberately not propagated.
 *
 * Some failures must not travel: telemetry may not fail a payment, an
 * after-commit effect has nothing left to undo, a cache bump may not
 * roll back the write it follows. Swallowing them is correct. Leaving
 * them visible only in a log line is not — nobody is paged by a log,
 * and the two cases found here both changed behaviour while staying
 * silent. A committed transaction whose side effect vanished, and a
 * stale validator that kept answering 304 after the data moved.
 *
 * In the kernel because the libraries that need it — persistence and
 * redis — sit below observability, which imports both. The kernel
 * imports nothing, so this is the one place a port can live without
 * closing a cycle.
 */
export interface FailureObserver {
  /**
   * @param site  Where it happened, as a stable label: `after-commit`,
   *              `resource-version-bump`. Low cardinality — it becomes a
   *              metric dimension.
   * @param reason Short classifier, not the message.
   */
  suppressed(site: string, reason: string): void;
}
