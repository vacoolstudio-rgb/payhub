/**
 * Somewhere to report how long a transaction took, without persistence
 * having to know what metrics are.
 *
 * `observability` already imports `persistence` — the outbox health
 * indicator reads the outbox repository — so injecting `MetricsService`
 * here would close a cycle between two libraries. A port inverts it:
 * persistence declares what it wants said, observability says it.
 *
 * Optional by construction. A unit test that builds a `TransactionManager`
 * by hand, or a service with no metrics wired, should not have to supply
 * a recorder to open a transaction.
 */
export const TRANSACTION_OBSERVER = Symbol.for('payhub:TransactionObserver');

export interface TransactionObserver {
  /**
   * @param isolation the level the transaction ran at
   * @param outcome   whether it committed or rolled back
   * @param seconds   wall-clock duration, including any retry's final attempt
   */
  record(isolation: string, outcome: 'commit' | 'rollback', seconds: number): void;
}
