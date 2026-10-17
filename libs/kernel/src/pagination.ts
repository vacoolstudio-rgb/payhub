/**
 * Keyset (cursor) pagination.
 *
 * OFFSET pagination degrades linearly and skips/duplicates rows when the set
 * changes under the reader — unacceptable for a transaction statement. The
 * cursor encodes the sort key of the last row seen.
 */
export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface CursorQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface KeysetCursor {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): KeysetCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as KeysetCursor).createdAt === 'string' &&
      typeof (parsed as KeysetCursor).id === 'string'
    ) {
      return parsed as KeysetCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch `limit + 1` rows, then call this to split off the look-ahead row. */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => KeysetCursor,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(toCursor(last)) : null,
  };
}
