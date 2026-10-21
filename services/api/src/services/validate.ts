import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest } from '../lib/errors';

export function parse<Out, In>(schema: ZodType<Out, ZodTypeDef, In>, value: unknown): Out {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
