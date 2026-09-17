import { PipeTransform, Injectable, type ArgumentMetadata } from '@nestjs/common';
import { ZodSchema } from 'zod';

/**
 * Validates and *transforms* with a zod schema from @bizbot/contracts.
 *
 * Transformation matters as much as validation: the phone schema normalizes
 * "+998 90 123 45 67" to storage form, and unknown keys are stripped so a client cannot
 * smuggle an extra field into a Prisma write.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
    return this.schema.parse(value);
  }
}

/** Route-level helper: `@Body(zodBody(createProductSchema)) dto: CreateProductInput` */
export const zodBody = (schema: ZodSchema) => new ZodValidationPipe(schema);
export const zodQuery = (schema: ZodSchema) => new ZodValidationPipe(schema);
