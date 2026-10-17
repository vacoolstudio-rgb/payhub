import type { TransactionManager } from '@payhub/persistence';
import { TransactionalContext } from '@payhub/persistence';

/**
 * Binds a pass-through transaction manager for unit tests.
 *
 * `@Transactional()` resolves the real manager from a static holder, which
 * is bound during module init. A pure unit test never boots that module, so
 * without this the first decorated call throws. Running the callback
 * directly is the right fake here: transaction *semantics* belong in the
 * Testcontainers suite, while these tests are about domain logic.
 *
 * Know what this cannot tell you. It does not roll back, so a method that
 * writes and then throws looks correct here and is silently undone in
 * production — which is exactly how the login lockout counter came to be
 * dead code. Anything that depends on a transaction boundary needs
 * `test/*.e2e-spec.ts` and a real database.
 */
export function bindTestTransactions(): () => void {
  const fake = {
    manager: undefined,
    isInTransaction: () => true,
    run: <T>(work: (manager: unknown) => Promise<T>): Promise<T> => work(undefined),
  } as unknown as TransactionManager;

  TransactionalContext.bind(fake);
  return () => TransactionalContext.reset();
}
