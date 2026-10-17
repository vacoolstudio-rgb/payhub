import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiHeader, ApiResponse } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../http/problem-details.dto.js';
import { IDEMPOTENCY_KEY_HEADER } from '../types/request-context.js';

/**
 * `applyDecorators` composes the error documentation every endpoint shares, so
 * the controllers stay readable instead of carrying ten `@ApiResponse` lines.
 */
export const ApiStandardErrors = (...statuses: number[]) =>
  applyDecorators(
    ApiExtraModels(ProblemDetailsDto),
    ...[401, 403, 422, 429, 500, ...statuses]
      .filter((status, index, all) => all.indexOf(status) === index)
      .map((status) =>
        ApiResponse({
          status,
          description: DESCRIPTIONS[status] ?? 'Error',
          type: ProblemDetailsDto,
        }),
      ),
  );

/** Documents the idempotency contract on a mutating endpoint. */
export const ApiIdempotent = () =>
  applyDecorators(
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: true,
      description:
        'Client-generated key (UUID v4 recommended). Retrying with the same key replays the original response instead of creating a second payment.',
    }),
    ApiResponse({
      status: 409,
      description: 'The key was reused with a different request body',
      type: ProblemDetailsDto,
    }),
  );

const DESCRIPTIONS: Record<number, string> = {
  400: 'Malformed request',
  401: 'Missing or invalid credentials',
  403: 'Authenticated but not allowed',
  404: 'Resource not found',
  409: 'Conflicting state',
  412: 'Aggregate was not in a valid state for this transition',
  422: 'Request failed validation',
  429: 'Rate limit exceeded',
  500: 'Unexpected server error',
  503: 'A downstream dependency is unavailable',
};
