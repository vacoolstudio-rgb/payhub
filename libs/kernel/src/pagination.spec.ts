import { describe, expect, it } from 'vitest';
import { buildPage, decodeCursor, encodeCursor } from './pagination.js';

interface Row {
  id: string;
  createdAt: Date;
}

const row = (id: string, iso: string): Row => ({ id, createdAt: new Date(iso) });

describe('keyset pagination', () => {
  it('round-trips a cursor', () => {
    const cursor = { createdAt: '2026-01-01T00:00:00.000Z', id: 'abc' };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is URL-safe', () => {
    const encoded = encodeCursor({ createdAt: new Date().toISOString(), id: 'a/b+c=' });

    expect(encoded).toMatch(/^[\w-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  /** A cursor is client-supplied input: a bad one must not crash the handler. */
  it('returns null for anything malformed', () => {
    for (const input of ['', 'not-base64!!', btoa('{}'), btoa('[1,2]'), btoa('{"id":1}')]) {
      expect(decodeCursor(input)).toBeNull();
    }
  });

  describe('buildPage', () => {
    const toCursor = (item: Row) => ({ createdAt: item.createdAt.toISOString(), id: item.id });

    it('uses the look-ahead row to report hasMore without a count query', () => {
      const rows = [
        row('1', '2026-01-03T00:00:00Z'),
        row('2', '2026-01-02T00:00:00Z'),
        row('3', '2026-01-01T00:00:00Z'),
      ];

      const page = buildPage(rows, 2, toCursor);

      expect(page.items.map((item) => item.id)).toEqual(['1', '2']);
      expect(page.hasMore).toBe(true);
      // The cursor points at the last *returned* row, not the look-ahead one.
      expect(decodeCursor(page.nextCursor!)).toEqual(toCursor(rows[1]!));
    });

    it('reports the end of the set', () => {
      const page = buildPage([row('1', '2026-01-01T00:00:00Z')], 5, toCursor);

      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it('handles an empty result', () => {
      const page = buildPage<Row>([], 10, toCursor);

      expect(page.items).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });
});
