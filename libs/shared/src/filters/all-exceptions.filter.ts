import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { DomainError } from '@payhub/kernel';
import { QueryFailedError } from 'typeorm';
import type { PayHubClsStore } from '../types/request-context.js';
import {
  PROBLEM_BASE_URI,
  humanize,
  type ProblemDetails,
  problemFromDomainError,
} from '../http/problem-details.js';

/**
 * The single exit point for every unhandled error.
 *
 * Responsibilities, in order:
 *   1. translate domain errors into RFC 9457 problem details;
 *   2. translate known infrastructure errors (unique violation, deadlock,
 *      lock timeout) into meaningful HTTP semantics instead of a blanket 500;
 *   3. never leak internals — unknown errors become a correlated 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    private readonly cls: ClsService<PayHubClsStore>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // GraphQL and RPC contexts have no HTTP response to write to.
    if (host.getType<string>() !== 'http') {
      throw exception;
    }

    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ url?: string; method?: string }>();
    const correlationId = this.cls.getId?.() ?? this.cls.get('correlationId');

    const problem = this.toProblem(exception, {
      instance: request?.url,
      correlationId,
    });

    this.log(exception, problem, request?.method);

    const response = ctx.getResponse();
    httpAdapter.setHeader?.(response, 'content-type', 'application/problem+json');
    httpAdapter.reply(response, problem, problem.status);
  }

  private toProblem(
    exception: unknown,
    context: { instance?: string | undefined; correlationId?: string | undefined },
  ): ProblemDetails {
    const base = {
      ...(context.instance === undefined ? {} : { instance: context.instance }),
      ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
    };

    if (exception instanceof DomainError) {
      return problemFromDomainError(exception, base);
    }

    if (exception instanceof HttpException) {
      return toProblemFromHttpException(exception, base);
    }

    const pgProblem = fromPostgresError(exception, base);
    if (pgProblem) {
      return pgProblem;
    }

    const exposed = fromExposedError(exception, base);
    if (exposed) {
      return exposed;
    }

    return {
      type: `${PROBLEM_BASE_URI}/internal-error`,
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred. Quote the correlation id when reporting it.',
      code: 'INTERNAL_ERROR',
      ...base,
      timestamp: new Date().toISOString(),
    } as ProblemDetails;
  }

  private log(exception: unknown, problem: ProblemDetails, method?: string): void {
    const prefix = `${method ?? 'UNKNOWN'} ${problem.instance ?? ''} → ${problem.status} ${problem.code}`;

    if (problem.status >= 500) {
      this.logger.error(prefix, exception instanceof Error ? exception.stack : String(exception));
      return;
    }
    if (problem.status === HttpStatus.TOO_MANY_REQUESTS) {
      this.logger.warn(prefix);
      return;
    }
    this.logger.debug(prefix);
  }
}

export function toProblemFromHttpException(
  exception: HttpException,
  base: { instance?: string | undefined; correlationId?: string | undefined },
): ProblemDetails {
  const status = exception.getStatus();
  const response = exception.getResponse();
  const payload =
    typeof response === 'string' ? { message: response } : (response as Record<string, unknown>);

  const message = payload['message'];
  // Nest puts arbitrary shapes in an HttpException body, so each field is
  // narrowed before it is rendered — `String({})` is "[object Object]",
  // which is a terrible thing to send a client as an error title.
  const code = asString(payload['code']) ?? httpStatusToCode(status);
  const title = asString(payload['error']) ?? humanize(code);

  return {
    // Built from `code`, never from the class name. `type` is the stable,
    // machine-readable half of RFC 7807 — the part a client branches on —
    // and the fallback used to mint it from `exception.name`, so a rate
    // limit went out as `errors/throttlerexception`, titled
    // "ThrottlerException". That URI is a published contract tied to a
    // class name inside @nestjs/throttler: it names our dependency to
    // every caller and changes if the library renames anything.
    type: `${PROBLEM_BASE_URI}/${code.toLowerCase().replace(/_/g, '-')}`,
    title,
    status,
    detail: stripClassPrefix(
      Array.isArray(message)
        ? message.map((item) => asString(item) ?? 'invalid value').join('; ')
        : (asString(message) ?? exception.message),
      exception.name,
    ),
    code,
    ...base,
    timestamp: new Date().toISOString(),
    ...(Array.isArray(message) ? { errors: { validation: message } } : {}),
  } as ProblemDetails;
}

/**
 * Middleware rejections that already know their own status code.
 *
 * body-parser, cors, multer and friends throw `http-errors` instances:
 * a `status` in the 4xx range and `expose: true`, meaning the message is
 * safe to show a client. None of them is an `HttpException`, so they
 * fell through to the catch-all and went out as 500 with a stack trace
 * in the log. Measured: a body over the limit answered
 * `500 INTERNAL_ERROR` where the error itself said 413, which turns a
 * caller's mistake into a page for whoever is on call.
 *
 * `expose` is the condition rather than the status alone: an error that
 * carries a 4xx but has not been marked safe to show is not one whose
 * message belongs in a response body.
 */
export function fromExposedError(
  exception: unknown,
  base: { instance?: string | undefined; correlationId?: string | undefined },
): ProblemDetails | null {
  if (typeof exception !== 'object' || exception === null) {
    return null;
  }

  const candidate = exception as { status?: unknown; expose?: unknown; message?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;

  if (status === undefined || status < 400 || status >= 500 || candidate.expose !== true) {
    return null;
  }

  const code = httpStatusToCode(status);

  return {
    type: `${PROBLEM_BASE_URI}/${code.toLowerCase().replace(/_/g, '-')}`,
    title: humanize(code),
    status,
    detail: asString(candidate.message) ?? humanize(code),
    code,
    ...base,
    timestamp: new Date().toISOString(),
  } as ProblemDetails;
}

/** Postgres SQLSTATE codes worth translating instead of hiding behind a 500. */
const PG_CODES: Record<string, { status: HttpStatus; code: string; detail: string }> = {
  '23505': {
    status: HttpStatus.CONFLICT,
    code: 'UNIQUE_VIOLATION',
    detail: 'A resource with the same unique key already exists',
  },
  '23503': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: 'FOREIGN_KEY_VIOLATION',
    detail: 'A referenced resource does not exist',
  },
  '23514': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: 'CHECK_VIOLATION',
    detail: 'A database invariant rejected the write',
  },
  // Class 22 — data exception. These are rejections of the *value*, so
  // they are the caller's input and not a server fault, however deep in
  // the stack they surface. Reaching one means an application-level
  // check is missing, which is worth fixing at the source; answering 500
  // in the meantime turns a bad request into a page for whoever is on
  // call. `Money` now bounds itself to this range, so 22003 should be
  // unreachable through the payment path — this is the floor under it.
  '22003': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: 'NUMERIC_OUT_OF_RANGE',
    detail: 'A numeric value is outside the range this system can store',
  },
  '22P02': {
    status: HttpStatus.BAD_REQUEST,
    code: 'INVALID_TEXT_REPRESENTATION',
    detail: 'A value was not in the format its column expects',
  },
  '40001': {
    status: HttpStatus.CONFLICT,
    code: 'SERIALIZATION_FAILURE',
    detail: 'The transaction conflicted with a concurrent one — retry the request',
  },
  '40P01': {
    status: HttpStatus.CONFLICT,
    code: 'DEADLOCK_DETECTED',
    detail: 'A deadlock was detected — retry the request',
  },
  '55P03': {
    status: HttpStatus.CONFLICT,
    code: 'LOCK_NOT_AVAILABLE',
    detail: 'The resource is locked by another operation — retry shortly',
  },
  '57014': {
    status: HttpStatus.GATEWAY_TIMEOUT,
    code: 'STATEMENT_TIMEOUT',
    detail: 'The database statement exceeded its time budget',
  },
};

function fromPostgresError(
  exception: unknown,
  base: { instance?: string | undefined; correlationId?: string | undefined },
): ProblemDetails | null {
  const driverError =
    exception instanceof QueryFailedError
      ? (exception.driverError as { code?: string } | undefined)
      : (exception as { code?: string } | undefined);

  const mapped = driverError?.code ? PG_CODES[driverError.code] : undefined;
  if (!mapped) {
    return null;
  }

  return {
    type: `${PROBLEM_BASE_URI}/${mapped.code.toLowerCase().replace(/_/g, '-')}`,
    title: mapped.code,
    status: mapped.status,
    detail: mapped.detail,
    code: mapped.code,
    ...base,
    timestamp: new Date().toISOString(),
  } as ProblemDetails;
}

/** Returns the value only when it is already a primitive worth printing. */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/**
 * Built once, not on every error.
 *
 * `Object.entries(HttpStatus).find(...)` allocated an array of ~60 pairs and
 * scanned it linearly for each exception — on the one code path that is
 * already hot during an incident.
 */
const STATUS_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(HttpStatus)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value as number, name]),
);

/**
 * Drops a leading `SomeException: ` from a message.
 *
 * Thrown exceptions outside our own code tend to prefix their own class
 * name — `ThrottlerException: Too Many Requests` — and that prefix is
 * noise to a caller and a small disclosure to anyone else.
 */
function stripClassPrefix(detail: string, name: string): string {
  return detail.startsWith(`${name}: `) ? detail.slice(name.length + 2) : detail;
}

function httpStatusToCode(status: number): string {
  return STATUS_NAMES.get(status) ?? `HTTP_${status}`;
}
