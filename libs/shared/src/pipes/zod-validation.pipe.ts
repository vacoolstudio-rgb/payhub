import { Injectable, type PipeTransform } from '@nestjs/common';
import { ValidationError } from '@payhub/kernel';
import type { ZodType } from 'zod';

/**
 * Validates and *narrows* an input with a Zod schema.
 *
 * class-validator is used for the REST DTOs (it plays nicely with Swagger's
 * metadata), while Zod is used where the shape is dynamic or shared with the
 * message contracts — same schema object on the producer and the consumer.
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationError('Request payload failed validation', {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return result.data;
  }
}

export const zodPipe = <T>(schema: ZodType<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
