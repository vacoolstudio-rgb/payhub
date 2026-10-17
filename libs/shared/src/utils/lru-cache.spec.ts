import { beforeEach, describe, expect, it } from 'vitest';
import { LruCache } from './lru-cache.js';

describe('LruCache', () => {
  let clock: number;
  const now = () => clock;

  const make = (maxEntries = 3, ttlMs = 1_000) => new LruCache<string>({ maxEntries, ttlMs, now });

  beforeEach(() => {
    clock = 0;
  });

  it('stores and returns values', () => {
    const cache = make();
    cache.set('a', 'A');

    expect(cache.get('a')).toBe('A');
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = make(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');

    cache.set('d', 'D');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe('D');
    expect(cache.size).toBe(3);
  });

  /** Reading an entry must make it young again — that is what "LRU" means. */
  it('a read refreshes recency', () => {
    const cache = make(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');

    cache.get('a');
    cache.set('d', 'D');

    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBeUndefined();
  });

  it('an overwrite also refreshes recency', () => {
    const cache = make(2);
    cache.set('a', 'A');
    cache.set('b', 'B');

    cache.set('a', 'A2');
    cache.set('c', 'C');

    expect(cache.get('a')).toBe('A2');
    expect(cache.get('b')).toBeUndefined();
  });

  it('expires entries by TTL', () => {
    const cache = make(10, 1_000);
    cache.set('a', 'A');

    clock = 999;
    expect(cache.get('a')).toBe('A');

    clock = 1_000;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('accepts a per-entry TTL', () => {
    const cache = make(10, 10_000);
    cache.set('short', 'S', 100);

    clock = 200;

    expect(cache.get('short')).toBeUndefined();
  });

  it('deletes by predicate, for pattern invalidation', () => {
    const cache = make(10);
    cache.set('wallet:1', 'A');
    cache.set('wallet:2', 'B');
    cache.set('payment:1', 'C');

    expect(cache.deleteWhere((key) => key.startsWith('wallet:'))).toBe(2);
    expect(cache.get('payment:1')).toBe('C');
    expect(cache.size).toBe(1);
  });

  it('reports hits, misses, evictions and expirations', () => {
    const cache = make(2, 100);
    cache.set('a', 'A');
    cache.get('a');
    cache.get('nope');

    cache.set('b', 'B');
    cache.set('c', 'C');

    clock = 500;
    cache.get('b');

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, evictions: 1, expirations: 1 });
  });

  it('clears everything', () => {
    const cache = make();
    cache.set('a', 'A');
    cache.clear();

    expect(cache.size).toBe(0);
  });
});
