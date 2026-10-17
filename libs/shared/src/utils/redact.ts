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
export function redact<T>(value: T, depth = 6): T {
  if (depth <= 0 || value === null || typeof value !== 'object') {
    return value;
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
