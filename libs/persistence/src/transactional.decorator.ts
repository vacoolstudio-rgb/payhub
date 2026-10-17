import type { TransactionManager, TransactionOptions } from './transaction.manager.js';

/**
 * Static bridge between the decorator (which has no DI access) and the
 * container-managed {@link TransactionManager}. Bound once during module
 * initialisation; a decorated method called before bootstrap throws loudly
 * instead of silently running outside a transaction.
 */
export class TransactionalContext {
  private static instance: TransactionManager | undefined;

  static bind(manager: TransactionManager): void {
    TransactionalContext.instance = manager;
  }

  static require(): TransactionManager {
    if (!TransactionalContext.instance) {
      throw new Error(
        '@Transactional() used before PersistenceModule finished initialising. ' +
          'Make sure the module that owns the method imports PersistenceModule.',
      );
    }
    return TransactionalContext.instance;
  }

  /** Test helper. */
  static reset(): void {
    TransactionalContext.instance = undefined;
  }
}

/**
 * Runs the decorated method inside a database transaction.
 *
 * ```ts
 * @Transactional({ isolation: 'REPEATABLE READ', retries: 3 })
 * async capture(command: CapturePayment) { … }
 * ```
 *
 * Any repository called underneath picks the ambient `EntityManager` up from
 * AsyncLocalStorage, so a nested service call is part of the same atomic unit
 * without passing a manager around.
 */
export function Transactional(options: TransactionOptions = {}): MethodDecorator {
  return (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    if (typeof original !== 'function') {
      throw new TypeError(`@Transactional() can only decorate methods (got ${String(propertyKey)})`);
    }

    descriptor.value = function transactionalWrapper(this: unknown, ...args: unknown[]) {
      return TransactionalContext.require().run(() => original.apply(this, args), options);
    };

    // Preserve decorator metadata (Nest route/param metadata, Swagger, …) that
    // was attached to the original function reference.
    for (const key of Reflect.getOwnMetadataKeys(original)) {
      Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, original), descriptor.value);
    }
    Object.defineProperty(descriptor.value, 'name', { value: original.name });

    return descriptor;
  };
}
