import { HttpStatus } from '@nestjs/common';
import { type DomainError, ErrorKind } from '@payhub/kernel';

/**
 * RFC 9457 "Problem Details for HTTP APIs".
 *
 * A single, documented error shape beats ad-hoc `{ message }` bodies: clients
 * branch on the stable `code`, humans read `detail`, and support correlates
 * incidents through `correlationId`.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: string;
  correlationId?: string;
  timestamp: string;
  errors?: Record<string, unknown>;
}

const KIND_TO_STATUS: Record<ErrorKind, HttpStatus> = {
  [ErrorKind.Validation]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorKind.NotFound]: HttpStatus.NOT_FOUND,
  [ErrorKind.Conflict]: HttpStatus.CONFLICT,
  [ErrorKind.Forbidden]: HttpStatus.FORBIDDEN,
  [ErrorKind.Unauthorized]: HttpStatus.UNAUTHORIZED,
  [ErrorKind.PreconditionFailed]: HttpStatus.PRECONDITION_FAILED,
  [ErrorKind.RateLimited]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorKind.Unavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorKind.Internal]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export const PROBLEM_BASE_URI = 'https://docs.payhub.dev/errors';

export function statusForKind(kind: ErrorKind): HttpStatus {
  return KIND_TO_STATUS[kind] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

export function problemFromDomainError(
  error: DomainError,
  context: { instance?: string; correlationId?: string },
): ProblemDetails {
  const status = statusForKind(error.kind);

  return {
    type: `${PROBLEM_BASE_URI}/${error.code.toLowerCase().replace(/_/g, '-')}`,
    title: humanize(error.code),
    status,
    detail: error.message,
    code: error.code,
    ...(context.instance ? { instance: context.instance } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    timestamp: new Date().toISOString(),
    ...(Object.keys(error.details).length > 0 ? { errors: error.details } : {}),
  };
}

export function humanize(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
