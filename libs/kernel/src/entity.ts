import type { DomainEvent } from './domain-event.js';

/** Identity-based equality: two entities are the same if their ids match. */
export abstract class Entity<TId> {
  protected constructor(readonly id: TId) {}

  equals(other?: Entity<TId> | null): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    if (other === this) {
      return true;
    }
    if (!(other instanceof Entity)) {
      return false;
    }
    return other.id === this.id;
  }
}

/**
 * Consistency boundary. Everything inside an aggregate is saved in one
 * transaction; anything across aggregates goes through domain/integration
 * events and is eventually consistent.
 */
export abstract class AggregateRoot<TId> extends Entity<TId> {
  #domainEvents: DomainEvent[] = [];
  #version = 0;

  /** Optimistic-locking version, owned by the persistence layer. */
  get version(): number {
    return this.#version;
  }

  /** @internal called by mappers when rehydrating from storage */
  setVersion(version: number): void {
    this.#version = version;
  }

  protected raise(event: DomainEvent): void {
    this.#domainEvents.push(event);
  }

  get domainEvents(): readonly DomainEvent[] {
    return this.#domainEvents;
  }

  /** Drains the buffer; the caller becomes responsible for publishing. */
  pullDomainEvents(): DomainEvent[] {
    const events = this.#domainEvents;
    this.#domainEvents = [];
    return events;
  }
}
