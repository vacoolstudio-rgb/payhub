export interface LruCacheOptions {
  /** Hard cap on entries. Eviction is least-recently-used. */
  readonly maxEntries: number;
  /** Default lifetime of an entry, in milliseconds. */
  readonly ttlMs: number;
  readonly now?: () => number;
}

export interface LruCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly size: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * In-process LRU cache with per-entry TTL.
 *
 * Implemented on a plain `Map`, which iterates in insertion order: deleting
 * and re-inserting a key on every read moves it to the tail, so the head is
 * always the least recently used one. That gives O(1) get, set and evict
 * without a hand-rolled doubly linked list — and with far less garbage,
 * since there are no node objects to allocate.
 *
 * Expiry is lazy (checked on read) plus opportunistic (the eviction scan
 * prefers an already-expired head). A background sweep would cost a timer
 * per cache for no benefit at these sizes.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly now: () => number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(private readonly options: LruCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.expirations += 1;
      this.misses += 1;
      return undefined;
    }

    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;

    return entry.value;
  }

  set(key: string, value: V, ttlMs = this.options.ttlMs): void {
    // Delete first so an overwrite also refreshes recency.
    this.entries.delete(key);

    if (this.entries.size >= this.options.maxEntries) {
      this.evictOldest();
    }

    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Drops every key matching a predicate — used for pattern invalidation. */
  deleteWhere(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (predicate(key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): LruCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      size: this.entries.size,
    };
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next();

    if (!oldest.done) {
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }
}
