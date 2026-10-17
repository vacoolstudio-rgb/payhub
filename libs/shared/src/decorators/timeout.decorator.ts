import { SetMetadata } from '@nestjs/common';

export const REQUEST_TIMEOUT_KEY = 'payhub:request-timeout-ms';

/**
 * Overrides the global request budget for one handler.
 * `@RequestTimeout(0)` disables it entirely — required for SSE streams.
 */
export const RequestTimeout = (ms: number) => SetMetadata(REQUEST_TIMEOUT_KEY, ms);
