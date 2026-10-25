const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'apikey',
  'api_key',
  'cookie',
  'pan',
  'cvv',
  'cardnumber',
  'iban',
]);

export const REDACTED = '[redacted]';

/** Defence in depth: even if a secret reaches a log call, it is not printed. */
export const TRUNCATED = '[truncated]';

export function redact<T>(value: T, depth = 6): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  /**
   * Past the cap the subtree is dropped, not returned.
   *
   * It used to `return value` here, which turned the guard against
   * infinite recursion into a hole in the redaction: anything deeper
   * than the cap went to the log exactly as it arrived. Measured — a
   * password and an `ph_live_` key seven levels down came back in
   * plain text, while the same keys one level down were masked.
   *
   * The test that covered this asserted only that a cyclic structure
   * did not throw, which an implementation that redacted nothing at
   * all would also satisfy. That is why it survived.
   */
  if (depth <= 0) {
    return TRUNCATED as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth - 1)) as unknown as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth - 1);
  }

  return output as T;
}

/** pino redaction paths — applied at the serializer level. */
export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.refreshToken',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.apiKey',
];
