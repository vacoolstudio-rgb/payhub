import type { EntityManager, EntityTarget, ObjectLiteral, Repository } from 'typeorm';
import type { TransactionManager } from './transaction.manager.js';

/**
 * Base for TypeORM-backed repositories.
 *
 * Subclasses never hold a `Repository` instance: they resolve it per call
 * from the ambient unit of work, which is what makes `@Transactional()`
 * transparent.
 */
export abstract class TypeOrmRepositoryBase<TEntity extends ObjectLiteral> {
  protected constructor(
    protected readonly transactions: TransactionManager,
    private readonly target: EntityTarget<TEntity>,
  ) {}

  protected get manager(): EntityManager {
    return this.transactions.manager;
  }

  protected get repository(): Repository<TEntity> {
    return this.manager.getRepository(this.target);
  }
}
